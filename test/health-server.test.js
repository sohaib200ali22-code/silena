const assert = require('node:assert/strict');
const test = require('node:test');
const { createHealthServer } = require('../health-server');

async function withHealthServer(isReady, run) {
    const server = createHealthServer({ port: 0, isReady });
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    try {
        const { port } = server.address();
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

test('health endpoint reports ready once Discord is connected', async () => {
    await withHealthServer(() => true, async url => {
        const response = await fetch(`${url}/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
    });
});

test('health endpoint reports unavailable while Discord is starting', async () => {
    await withHealthServer(() => false, async url => {
        const response = await fetch(`${url}/health`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: 'starting' });
    });
});

test('rejects invalid listening ports', () => {
    assert.throws(
        () => createHealthServer({ port: 'invalid', isReady: () => true }),
        /PORT must be an integer/
    );
});
