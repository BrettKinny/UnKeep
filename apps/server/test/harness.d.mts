export interface TestServer {
  endpoint: string;
  setupToken: string;
  stop(): Promise<void>;
}

export interface TestServerOptions {
  setupToken?: string;
  env?: Record<string, string>;
}

export function startTestServer(options?: TestServerOptions): Promise<TestServer>;
