const assert = require('assert/strict');
const test = require('node:test');

const { getApproxBodySize, payloadTooLargeHandler } = require('../utils/payloadErrors');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('getApproxBodySize prefers parser length then content-length', () => {
  assert.equal(getApproxBodySize({ length: 150001 }, { headers: { 'content-length': '10' } }), 150001);
  assert.equal(getApproxBodySize({}, { headers: { 'content-length': '120345' } }), 120345);
  assert.equal(getApproxBodySize({}, { headers: {} }), null);
});

test('payloadTooLargeHandler returns safe JSON 413', () => {
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args);

  try {
    const res = createResponse();
    let nextCalled = false;

    payloadTooLargeHandler(
      { name: 'PayloadTooLargeError', status: 413, length: 150001 },
      {
        method: 'PUT',
        originalUrl: '/api/projects/64f000000000000000000001',
        headers: { 'content-length': '150001' },
      },
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, {
      message: 'Payload excede o limite permitido.',
      code: 'PAYLOAD_TOO_LARGE',
    });
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0][1], {
      route: 'PUT /api/projects/64f000000000000000000001',
      approxBytes: 150001,
      name: 'PayloadTooLargeError',
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('payloadTooLargeHandler passes non-413 errors through', () => {
  const res = createResponse();
  const error = new Error('boom');
  let passedError = null;

  payloadTooLargeHandler(error, { headers: {} }, res, (nextError) => {
    passedError = nextError;
  });

  assert.equal(passedError, error);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});
