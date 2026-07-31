import assert from 'node:assert/strict';
import test from 'node:test';

import { inventoryGhcr } from './inventory-ghcr.mjs';

function response(status, body) {
  return {
    status,
    json: async () => body,
  };
}

async function inventoryFromPackageRecords(records, packageName = 'unkeep') {
  return inventoryGhcr({
    owner: 'BrettKinny',
    packageName,
    token: 'test-token',
    fetchImpl: async url => (
      new URL(url).pathname === '/users/BrettKinny'
        ? response(200, { type: 'User' })
        : response(200, records)
    ),
  });
}

test('proves package absence by listing a user namespace', async () => {
  const paths = [];
  const versions = await inventoryGhcr({
    owner: 'BrettKinny',
    packageName: 'unkeep',
    token: 'test-token',
    fetchImpl: async url => {
      const path = new URL(url).pathname + new URL(url).search;
      paths.push(path);
      if (path === '/users/BrettKinny') return response(200, { type: 'User' });
      return response(200, []);
    },
  });

  assert.deepEqual(versions, []);
  assert.equal(paths[1], '/users/BrettKinny/packages?package_type=container&per_page=100&page=1');
});

test('supports organization packages and returns their versions', async () => {
  const version = {
    id: 1,
    metadata: { container: { tags: ['0.2.0-rc.1'] } },
  };
  const versions = await inventoryGhcr({
    owner: 'ExampleOrg',
    packageName: 'unkeep',
    token: 'test-token',
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path === '/users/ExampleOrg') return response(200, { type: 'Organization' });
      if (path === '/orgs/ExampleOrg/packages') {
        return response(200, [{ name: 'unkeep', package_type: 'container' }]);
      }
      if (path === '/orgs/ExampleOrg/packages/container/unkeep/versions') {
        return response(200, [version]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(versions, [version]);
});

test('fails closed on package API errors instead of treating 404 as absence', async () => {
  await assert.rejects(
    inventoryGhcr({
      owner: 'BrettKinny',
      packageName: 'unkeep',
      token: 'test-token',
      fetchImpl: async url => (
        new URL(url).pathname === '/users/BrettKinny'
          ? response(200, { type: 'User' })
          : response(404, { message: 'Not Found' })
      ),
    }),
    /HTTP 404/,
  );
});

test('fails closed on malformed package inventory records', async () => {
  const malformedRecords = [
    null,
    'unkeep',
    [],
    {},
    { name: 42, package_type: 'container' },
    { name: 'unkeep' },
    { name: 'unkeep', package_type: 'npm' },
  ];

  for (const record of malformedRecords) {
    await assert.rejects(
      inventoryFromPackageRecords([record]),
      /invalid package record at index 0/,
    );
  }
});

test('fails closed on duplicate or case-ambiguous package names', async () => {
  await assert.rejects(
    inventoryFromPackageRecords([
      { name: 'unkeep', package_type: 'container' },
      { name: 'unkeep', package_type: 'container' },
    ]),
    /duplicate packages/,
  );
  await assert.rejects(
    inventoryFromPackageRecords([
      { name: 'UnKeep', package_type: 'container' },
    ]),
    /ambiguous package name/,
  );
});

test('accepts well-formed unrelated package records as proof of absence', async () => {
  const versions = await inventoryFromPackageRecords([
    { name: 'another-package', package_type: 'container' },
  ]);
  assert.deepEqual(versions, []);
});
