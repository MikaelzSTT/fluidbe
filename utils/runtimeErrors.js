function runtimeError(res, status, code, message) {
  return res.status(status).json({
    error: true,
    code,
    message,
  });
}

module.exports = {
  runtimeError,
};
