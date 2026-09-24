import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One in-memory MongoDB for the whole run. Each test file connects with its
 * own database name (see helpers/app.ts) so files can run in parallel.
 */
let mongod: MongoMemoryServer | null = null;

export async function setup(project: TestProject): Promise<void> {
  mongod = await MongoMemoryServer.create();
  project.provide('mongoUri', mongod.getUri());
}

export async function teardown(): Promise<void> {
  await mongod?.stop();
  mongod = null;
}
