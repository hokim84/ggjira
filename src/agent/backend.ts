export interface BackendAdapter {
  id: string;
  isAvailable(): boolean | Promise<boolean>;
}

export class BackendRegistry {
  private readonly adapters = new Map<string, BackendAdapter>();

  register(adapter: BackendAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): BackendAdapter | undefined {
    return this.adapters.get(id);
  }

  async missing(required: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const id of new Set(required)) {
      const adapter = this.adapters.get(id);
      if (!adapter || !(await adapter.isAvailable())) missing.push(id);
    }
    return missing;
  }
}

export class UnavailableBackend implements BackendAdapter {
  constructor(readonly id: string) {}
  isAvailable(): boolean {
    return false;
  }
}
