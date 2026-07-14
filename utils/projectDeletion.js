const fs = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const BuildJob = require('../models/BuildJob');
const ConnectorSecret = require('../models/ConnectorSecret');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const RuntimeDocument = require('../models/RuntimeDocument');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const REACT_VITE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'react-vite-builds');

async function deleteBuildFiles(projectIds) {
  await Promise.all(projectIds.flatMap((projectId) => [
    fs.rm(path.join(PUBLIC_BUILDS_DIR, String(projectId)), { recursive: true, force: true }),
    fs.rm(path.join(REACT_VITE_STORAGE_DIR, String(projectId)), { recursive: true, force: true }),
  ]));

  if (!mongoose.connection.db || projectIds.length === 0) return;
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'react_vite_sources',
  });
  const files = await bucket.find({
    'metadata.projectId': { $in: projectIds.map(String) },
  }).toArray();
  await Promise.all(files.map((file) => bucket.delete(file._id)));
}

async function deleteProjectsData(projectIds) {
  const ids = projectIds.filter(Boolean);
  if (!ids.length) return;
  const projectFilter = { projectId: { $in: ids } };

  await Promise.all([
    BuildJob.deleteMany(projectFilter),
    ConnectorSecret.deleteMany(projectFilter),
    ProjectBuild.deleteMany(projectFilter),
    ProjectChangeRequest.deleteMany(projectFilter),
    ProjectMessage.deleteMany(projectFilter),
    RuntimeDocument.deleteMany(projectFilter),
    Project.deleteMany({ _id: { $in: ids } }),
  ]);
  await deleteBuildFiles(ids);
}

module.exports = { deleteProjectsData };
