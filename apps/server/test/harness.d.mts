export interface TestServer {
  endpoint: string;
  instanceId: string;
  dataDir: string;
  setupToken: string;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface TestServerOptions {
  setupToken?: string;
  env?: Record<string, string>;
  preserveDataDir?: boolean;
}

export function startTestServer(options?: TestServerOptions): Promise<TestServer>;
