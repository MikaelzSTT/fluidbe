function getApproxBodySize(error, req) {
  if (Number.isFinite(error?.length)) {
    return error.length;
  }

  if (Number.isFinite(error?.expected)) {
    return error.expected;
  }

  const contentLength = Number.parseInt(req?.headers?.['content-length'] || '', 10);
  return Number.isFinite(contentLength) ? contentLength : null;
}

function getSafeRequestRoute(req) {
  const pathname = typeof req?.path === 'string' && req.path
    ? req.path
    : String(req?.originalUrl || req?.url || '').split('?')[0];

  return `${req?.method || 'UNKNOWN'} ${pathname || '/'}`;
}

function payloadTooLargeHandler(error, req, res, next) {
  const status = error?.status || error?.statusCode;
  const isPayloadTooLarge =
    status === 413 ||
    error?.type === 'entity.too.large' ||
    error?.name === 'PayloadTooLargeError';

  if (!isPayloadTooLarge) {
    return next(error);
  }

  const approxBytes = getApproxBodySize(error, req);
  console.warn('Payload rejeitado por tamanho.', {
    route: getSafeRequestRoute(req),
    approxBytes,
    name: error?.name || 'PayloadTooLargeError',
  });

  if (res.headersSent) {
    return next(error);
  }

  return res.status(413).json({
    message: 'Payload excede o limite permitido.',
    code: 'PAYLOAD_TOO_LARGE',
  });
}

module.exports = {
  getApproxBodySize,
  getSafeRequestRoute,
  payloadTooLargeHandler,
};
