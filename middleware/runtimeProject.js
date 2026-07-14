const mongoose = require('mongoose');
const Project = require('../models/Project');
const { runtimeError } = require('../utils/runtimeErrors');

async function validateRuntimeProject(req, res, next) {
  try {
    const { projectId } = req.params;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return runtimeError(res, 400, 'RUNTIME_INVALID_PROJECT', 'Invalid runtime project.');
    }

    const project = await Project.findById(projectId);

    if (!project) {
      return runtimeError(res, 404, 'RUNTIME_PROJECT_NOT_FOUND', 'Runtime project not found.');
    }

    if (project.runtimeEnabled !== true) {
      return runtimeError(res, 403, 'RUNTIME_ACCESS_DENIED', 'Runtime access denied.');
    }

    req.runtimeProject = project;
    req.runtimeProjectId = project._id;

    return next();
  } catch (error) {
    console.error('Runtime project validation failed.', {
      name: error?.name || 'Error',
      code: error?.code || null,
    });
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
  }
}

module.exports = {
  validateRuntimeProject,
};
