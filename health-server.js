const express = require('express');

function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('PORT must be an integer between 0 and 65535.');
    }
    return port;
}

function createHealthServer({ port = process.env.PORT || 10000, isReady }) {
    if (typeof isReady !== 'function') {
        throw new TypeError('isReady must be a function.');
    }

    const app = express();
    app.disable('x-powered-by');
    app.get('/health', (_request, response) => {
        const ready = isReady();
        response.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'starting' });
    });

    return app.listen(parsePort(port), '0.0.0.0');
}

module.exports = { createHealthServer };
