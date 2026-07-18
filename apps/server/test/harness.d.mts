export interface TestServer {
  endpoint: string;
  setupToken: string;
  stop(): Promise<void>;
}

export interface TestServerOptions {
  setupToken?: string;
}

export function startTestServer(options?: TestServerOptions): Promise<TestServer>;
