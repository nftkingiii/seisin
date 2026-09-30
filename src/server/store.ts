import { DatabaseSync } from "node:sqlite";
import {
  genesis,
  applyEpoch,
  refuseChange,
  recordHash,
  replay,
  type Change,
  type RegistryRecord,
  type RegistryState,
} from "../core/registry.js";

export interface StoredAnchor {
  txid: string;
  proof: string;
  height: number;
}

export interface EpochRow {
  record: RegistryRecord;
  hash: string;
  changes: Change[];
  anchor: StoredAnchor | null;
  sealedAt: string;
}

/*
 * The operator's store. Everything in it is public except nothing: genesis
 * owner keys, sealed batches and pending changes are all meant to be read.
 * The registry state is always rebuilt by replaying the log, so the store
 * cannot hold a state that the public log would not reproduce.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists meta (k text primary key, v text not null);
      create table if not exists epochs (n integer primary key, record text not null, changes text not null, anchor text, sealed_at text not null);
      create table if not exists pending (id integer primary key autoincrement, change text not null, note text not null, at text not null);
    `);
  }

  private get(k: string): string | undefined {
    return (this.db.prepare("select v from meta where k = ?").get(k) as { v: string } | undefined)?.v;
  }

  initialized(): boolean {
    return this.get("collection") !== undefined;
  }

  init(collection: string, owners: string[]) {
    if (this.initialized()) throw new Error("registry already exists");
    const s = genesis(collection, owners);
    this.db.exec("begin");
    this.db.prepare("insert into meta values ('collection', ?), ('genesis', ?)").run(collection, JSON.stringify(owners));
    this.db.prepare("insert into epochs values (0, ?, '[]', null, ?)").run(JSON.stringify(s.record), new Date().toISOString());
    this.db.exec("commit");
  }

  collection(): string {
    return this.get("collection")!;
  }

  genesisOwners(): string[] {
    return JSON.parse(this.get("genesis")!);
  }

  epochs(): EpochRow[] {
    return (this.db.prepare("select * from epochs order by n").all() as any[]).map((r) => {
      const record = JSON.parse(r.record) as RegistryRecord;
      return { record, hash: recordHash(record), changes: JSON.parse(r.changes), anchor: r.anchor ? JSON.parse(r.anchor) : null, sealedAt: r.sealed_at };
    });
  }

  /** Current state, rebuilt from the log and checked against every stored record. */
  state(): RegistryState {
    const rows = this.epochs();
    const recs = replay(this.collection(), this.genesisOwners(), rows.slice(1).map((r) => r.changes));
    rows.forEach((r, i) => {
      if (recordHash(recs[i]) !== r.hash) throw new Error(`stored record ${i} does not replay`);
    });
    let s = genesis(this.collection(), this.genesisOwners());
    for (const r of rows.slice(1)) s = applyEpoch(s, r.changes);
    return s;
  }

  pending(): { id: number; change: Change; note: string; at: string }[] {
    return (this.db.prepare("select * from pending order by id").all() as any[]).map((r) => ({ id: r.id, change: JSON.parse(r.change), note: r.note, at: r.at }));
  }

  /** Queues a change for the next epoch after checking it against the current state and the queue. */
  submit(c: Change, note: string) {
    const s = this.state();
    const queue = this.pending().map((p) => p.change);
    const why = refuseChange(s, c, new Set(queue.map((q) => q.tokenId)), new Set(queue.map((q) => q.to)));
    if (why) throw new Error(why);
    this.db.prepare("insert into pending (change, note, at) values (?, ?, ?)").run(JSON.stringify(c), note, new Date().toISOString());
  }

  /**
   * Seals the queue into a new epoch. Records chain by hash, so anchoring the
   * newest record also commits to every record before it.
   */
  seal(): EpochRow {
    const queue = this.pending();
    if (queue.length === 0) throw new Error("nothing to seal");
    const next = applyEpoch(this.state(), queue.map((q) => q.change));
    this.db.exec("begin");
    this.db.prepare("insert into epochs values (?, ?, ?, null, ?)").run(next.epoch, JSON.stringify(next.record), JSON.stringify(queue.map((q) => q.change)), new Date().toISOString());
    this.db.prepare("delete from pending").run();
    this.db.exec("commit");
    return this.epochs()[next.epoch];
  }

  setAnchor(n: number, a: StoredAnchor) {
    const row = this.epochs()[n];
    if (!row) throw new Error("no such epoch");
    if (row.anchor) throw new Error(`epoch ${n} is already anchored`);
    const latest = this.epochs().filter((r) => r.anchor).pop();
    if (latest && latest.record.epoch > n) throw new Error(`epoch ${latest.record.epoch} is already anchored; anchors only move forward`);
    this.db.prepare("update epochs set anchor = ? where n = ?").run(JSON.stringify(a), n);
  }
}
