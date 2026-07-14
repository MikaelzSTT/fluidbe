const os = require('os');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const {
  collectConnectorInjectionBuildFiles,
  createTemporaryFrontendEnv,
  resolveProjectConnectorInjection,
} = require('../utils/connectorInjection');
const { createSourceContext } = require('../utils/sourceContext');
const { generateFallbackAppName } = require('../utils/projectNaming');
const { reactViteBuildHelpers } = require('../routes/adminRoutes');

dotenv.config();

const {
  applyTsconfigDeprecationFix,
  collectBuildArtifactFiles,
  collectProjectSourceFiles,
  ensureViteRelativeBase,
  extractZipSafely,
  findReactViteRoot,
  fixDistIndexAssetPaths,
  formatConnectorInjectionLog,
  publishValidatedDist,
  redactBuildLogs,
  runReactViteInstall,
  runReactViteBuild,
  validateReactViteProject,
} = reactViteBuildHelpers;

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const MAX_MONGO_ARTIFACT_BYTES = Number(process.env.MAX_MONGO_ARTIFACT_BYTES || 8 * 1024 * 1024);
const MAX_MONGO_SOURCE_BYTES = Number(process.env.MAX_MONGO_SOURCE_BYTES || 3 * 1024 * 1024);
const POLL_INTERVAL_MS = Number(process.env.REACT_VITE_WORKER_POLL_INTERVAL_MS || 5000);
const LEASE_MS = Number(process.env.REACT_VITE_WORKER_LEASE_MS || 75 * 60 * 1000);
const WORKER_ID = process.env.REACT_VITE_WORKER_ID || `${os.hostname()}-${process.pid}`;
const VISUAL_CONTEXT_ENABLED = String(process.env.VISUAL_CONTEXT_ENABLED || 'false').toLowerCase() === 'true';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkspacePath(jobId) {
  return path.join(os.tmpdir(), 'fluid-react-vite-worker', String(jobId));
}

function buildPreviewUrl(projectId, jobId) {
  return `/builds/${projectId}/${jobId}/index.html`;
}

function reserveVisualPreviewContext(previewUrl) {
  // Future integration point: this is where a preview screenshot could be prepared.
  // No browser, screenshot capture, image storage, or model image input is enabled here.
  if (VISUAL_CONTEXT_ENABLED && previewUrl) {
    console.info('[react-vite-worker] Visual context is reserved; preview capture is disabled.');
  }
}

function getGridFsBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'react_vite_sources',
  });
}

async function downloadSourceZip(bucket, sourceGridFsFileId, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(
    bucket.openDownloadStream(sourceGridFsFileId),
    fsSync.createWriteStream(destinationPath, { mode: 0o600 })
  );
}

async function claimNextJob() {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const available = {
    type: 'react_vite',
    $or: [
      { status: 'queued' },
      { status: { $in: ['claimed', 'running'] }, leaseUntil: { $lte: now } },
    ],
  };

  return BuildJob.findOneAndUpdate(
    available,
    {
      $set: { status: 'claimed', claimedBy: WORKER_ID, leaseUntil },
      $inc: { attempt: 1 },
    },
    { returnDocument: 'after', sort: { queuedAt: 1, _id: 1 } }
  );
}

async function markRunning(job) {
  const now = new Date();
  const result = await BuildJob.findOneAndUpdate(
    { _id: job._id, status: 'claimed', claimedBy: WORKER_ID },
    {
      $set: {
        status: 'running',
        startedAt: now,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    },
    { returnDocument: 'after' }
  );

  return result;
}

async function runBuildPipeline(job, workspace) {
  const sourceZipPath = path.join(workspace, 'source.zip');
  const extractDir = path.join(workspace, 'source');
  const bucket = getGridFsBucket();
  let logs = '';
  let temporaryFrontendEnvRedactionValues = [];
  let temporaryFrontendEnv = null;
  let sourceZipDeleted = false;
  let publicBuildDir = null;

  try {
    if (!job.sourceGridFsFileId) {
      throw new Error('BuildJob não possui ZIP de origem.');
    }

    await downloadSourceZip(bucket, job.sourceGridFsFileId, sourceZipPath);
    await extractZipSafely(sourceZipPath, extractDir);

    const appRoot = await findReactViteRoot(extractDir);
    await validateReactViteProject(appRoot);

    let connectorInjection = {
      requiredEnvVars: [], frontendEnvVars: [], backendEnvVars: [], resolvedConnectors: [],
      unresolvedConnectors: [], injectionPlan: [], blockedEnvVars: [], unresolvedBackendEnvVars: [],
    };
    try {
      const buildFiles = await collectConnectorInjectionBuildFiles(appRoot);
      connectorInjection = await resolveProjectConnectorInjection(job.projectId, buildFiles);
      logs += `${formatConnectorInjectionLog(connectorInjection)}\n`;
    } catch (error) {
      logs += `Connector injection plan unavailable: ${error.message}\n`;
    }

    temporaryFrontendEnv = await createTemporaryFrontendEnv({
      projectId: job.projectId,
      projectDir: appRoot,
      injectionPlan: connectorInjection.injectionPlan,
    });
    temporaryFrontendEnvRedactionValues = Object.values(temporaryFrontendEnv.envValues || {});
    if (temporaryFrontendEnv.injectedEnvVars.length > 0) {
      logs += `Frontend env vars injected: ${temporaryFrontendEnv.injectedEnvVars.join(', ')}\n`;
    }

    try {
      logs += `${await runReactViteInstall(appRoot)}\n`;
      for (const fixedPath of await applyTsconfigDeprecationFix(appRoot)) {
        logs += `Auto-fix TS5107 aplicado em: ${fixedPath}\n`;
      }
      const viteConfigFixed = await ensureViteRelativeBase(appRoot);
      if (viteConfigFixed) logs += `Auto-fix aplicado: base './' em ${viteConfigFixed}.\n`;
      logs += await runReactViteBuild(appRoot, { frontendEnv: temporaryFrontendEnv.envValues });
    } finally {
      await temporaryFrontendEnv.cleanup();
      temporaryFrontendEnv = null;
    }

    const distDir = path.join(appRoot, 'dist');
    if (!(await pathExists(distDir))) throw new Error('Build concluído sem gerar a pasta dist.');
    await reactViteBuildHelpers.validateDistDirectory(distDir);
    if (await fixDistIndexAssetPaths(distDir)) {
      logs += '\nAuto-fix aplicado: caminhos /assets/ corrigidos em dist/index.html.\n';
      await reactViteBuildHelpers.validateDistDirectory(distDir);
    }

    const fullHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
    const artifactSnapshot = await collectBuildArtifactFiles(distDir);
    const sourceSnapshot = await collectProjectSourceFiles(appRoot);
    const sourceContext = createSourceContext(sourceSnapshot.files);
    if (!artifactSnapshot.complete) {
      logs += `\nAviso: dist gerado excedeu ${MAX_MONGO_ARTIFACT_BYTES} bytes; ${artifactSnapshot.skippedFiles} arquivo(s) menos prioritario(s) nao foram salvos no fallback MongoDB.\n`;
    }
    if (!sourceSnapshot.complete) {
      logs += `\nAviso: source excedeu ${MAX_MONGO_SOURCE_BYTES} bytes; ${sourceSnapshot.skippedFiles} arquivo(s) menos prioritario(s) nao foram salvos no fallback MongoDB.\n`;
    }

    const previewUrl = buildPreviewUrl(job.projectId, job._id);
    reserveVisualPreviewContext(previewUrl);
    publicBuildDir = path.join(PUBLIC_BUILDS_DIR, String(job.projectId), String(job._id));
    await publishValidatedDist(distDir, publicBuildDir);

    const build = await ProjectBuild.findOneAndUpdate(
      { _id: job.projectBuildId, projectId: job.projectId },
      {
        $set: {
          distUrl: previewUrl, previewUrl, buildUrl: previewUrl, deployUrl: previewUrl,
          fullHtml, artifactFiles: artifactSnapshot.files, sourceFiles: sourceSnapshot.files,
          sourceSummary: sourceContext.sourceSummary, indexedFiles: sourceContext.indexedFiles, sourceZipUrl: '',
          logs: [redactBuildLogs(logs, temporaryFrontendEnvRedactionValues), 'React/Vite build concluído com sucesso.'].filter(Boolean).join('\n'),
        },
      },
      { returnDocument: 'after', runValidators: true }
    );
    if (!build) {
      throw new Error('ProjectBuild não encontrado para o BuildJob.');
    }

    const project = await Project.findById(job.projectId).select('appName appNameLocked prompt name title description');
    if (project && (!project.appName || project.appNameLocked !== true)) {
      const appName = generateFallbackAppName(project, project.prompt, build);
      if (appName) {
        await Project.updateOne(
          { _id: project._id, appNameLocked: { $ne: true } },
          { $set: { appName, appNameSource: 'generated' } },
          { runValidators: true }
        );
      }
    }

    if (build.status === 'in_progress') {
      const transitionedBuild = await ProjectBuild.findOneAndUpdate(
        { _id: build._id, projectId: job.projectId, status: 'in_progress' },
        { $set: { status: 'draft' } },
        { returnDocument: 'after', runValidators: true }
      );

      if (!transitionedBuild) {
        const currentBuild = await ProjectBuild.findOne({
          _id: job.projectBuildId,
          projectId: job.projectId,
        }).select('status');

        if (!currentBuild || currentBuild.status !== 'done') {
          throw new Error('ProjectBuild mudou de estado antes da conclusão do worker.');
        }
      }
    } else if (build.status !== 'done') {
      throw new Error(`ProjectBuild está em estado inesperado: ${build.status}.`);
    }

    await bucket.delete(job.sourceGridFsFileId);
    sourceZipDeleted = true;
    await BuildJob.updateOne(
      { _id: job._id, claimedBy: WORKER_ID },
      { $set: { status: 'succeeded', finishedAt: new Date(), leaseUntil: null, errorCode: '', errorMessage: '' } }
    );
  } catch (error) {
    const message = redactBuildLogs([logs, error.message].filter(Boolean).join('\n'), temporaryFrontendEnvRedactionValues);
    await ProjectBuild.updateOne(
      { _id: job.projectBuildId, projectId: job.projectId, status: { $ne: 'done' } },
      { $set: { status: 'failed', logs: message } },
      { runValidators: true }
    ).catch(() => {});
    await BuildJob.updateOne(
      { _id: job._id, claimedBy: WORKER_ID },
      {
        $set: {
          status: 'failed', finishedAt: new Date(), leaseUntil: null,
          errorCode: 'REACT_VITE_BUILD_FAILED', errorMessage: message.slice(0, 4000),
        },
      }
    ).catch(() => {});
    if (publicBuildDir) await fs.rm(publicBuildDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (temporaryFrontendEnv) await temporaryFrontendEnv.cleanup().catch(() => {});
    if (!sourceZipDeleted && job.sourceGridFsFileId) await bucket.delete(job.sourceGridFsFileId).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function processOneJob() {
  const claimedJob = await claimNextJob();
  if (!claimedJob) return false;
  const job = await markRunning(claimedJob);
  if (!job) return true;

  const workspace = buildWorkspacePath(job._id);
  await fs.rm(workspace, { recursive: true, force: true });
  try {
    await runBuildPipeline(job, workspace);
    console.log(`[react-vite-worker] job ${job._id} succeeded`);
  } catch (error) {
    console.error(`[react-vite-worker] job ${job._id} failed`, {
      name: error?.name || 'Error',
      code: error?.code || null,
    });
  }
  return true;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI é obrigatório para o worker.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[react-vite-worker] connected as ${WORKER_ID}`);

  while (true) {
    const processed = await processOneJob();
    if (!processed) await wait(POLL_INTERVAL_MS);
  }
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[react-vite-worker] received ${signal}, shutting down`);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(async (error) => {
  console.error('[react-vite-worker] fatal', {
    name: error?.name || 'Error',
    code: error?.code || null,
  });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
