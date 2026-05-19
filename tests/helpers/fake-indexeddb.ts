type FakeRequest<T> = {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

type FakeOpenRequest = FakeRequest<FakeIDBDatabase> & {
  onupgradeneeded: (() => void) | null;
};

type FakeStoreOptions = {
  keyPath?: string;
};

type FakeStoreData = {
  keyPath?: string;
  rows: Map<IDBValidKey, unknown>;
};

export class FakeIndexedDBFactory {
  private readonly databases = new Map<string, FakeIDBDatabase>();

  open(name: string, _version?: number): FakeOpenRequest {
    const existing = this.databases.get(name);
    const database = existing ?? new FakeIDBDatabase();
    if (!existing) this.databases.set(name, database);
    const request: FakeOpenRequest = {
      result: database,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };
    queueMicrotask(() => {
      if (!existing) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

class FakeIDBDatabase {
  private readonly stores = new Map<string, FakeStoreData>();

  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  };

  createObjectStore(name: string, options: FakeStoreOptions = {}): FakeIDBObjectStore {
    const store = { keyPath: options.keyPath, rows: new Map<IDBValidKey, unknown>() };
    this.stores.set(name, store);
    return new FakeIDBObjectStore(store);
  }

  transaction(name: string, _mode: IDBTransactionMode): FakeIDBTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`fake IndexedDB store does not exist: ${name}`);
    return new FakeIDBTransaction(store);
  }
}

class FakeIDBTransaction {
  error: Error | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly store: FakeStoreData) {}

  objectStore(_name: string): FakeIDBObjectStore {
    return new FakeIDBObjectStore(this.store);
  }
}

class FakeIDBObjectStore {
  constructor(private readonly store: FakeStoreData) {}

  put(value: unknown, key?: IDBValidKey): FakeRequest<IDBValidKey> {
    const resolvedKey = key ?? this.keyFromValue(value);
    this.store.rows.set(resolvedKey, structuredClone(value));
    return successfulRequest(resolvedKey);
  }

  get(key: IDBValidKey): FakeRequest<unknown | undefined> {
    const value = this.store.rows.get(key);
    return successfulRequest(value === undefined ? undefined : structuredClone(value));
  }

  getAll(): FakeRequest<unknown[]> {
    return successfulRequest(Array.from(this.store.rows.values()).map((value) => structuredClone(value)));
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    this.store.rows.delete(key);
    return successfulRequest(undefined);
  }

  count(): FakeRequest<number> {
    return successfulRequest(this.store.rows.size);
  }

  private keyFromValue(value: unknown): IDBValidKey {
    const keyPath = this.store.keyPath;
    if (!keyPath || value === null || typeof value !== "object") throw new Error("fake IndexedDB put requires a key");
    const key = (value as Record<string, unknown>)[keyPath];
    if (typeof key !== "string" && typeof key !== "number") throw new Error(`fake IndexedDB invalid keyPath value: ${keyPath}`);
    return key;
  }
}

function successfulRequest<T>(result: T): FakeRequest<T> {
  const request: FakeRequest<T> = {
    result,
    error: null,
    onsuccess: null,
    onerror: null
  };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}
