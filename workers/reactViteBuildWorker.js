const os = require('os');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const {
  collectConnectorInjectionBuildFiles,
  createTemporaryFrontendEnv,
  resolveProjectConnectorInjection,
} = require('../utils/connectorInjection');
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
  redactBuildLogs,
  runNpmCommand,
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
const MAX_INDEXED_SOURCE_FILES = 30;
const MAX_INDEXED_FILE_EXCERPT_CHARS = 2000;
const INDEXED_SOURCE_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx', '.yaml', '.yml',
]);
const INDEXED_SOURCE_BINARY_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.ogg', '.wav', '.webm',
]);

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

function isUsefulSourceFile(relativePath) {
  const normalizedPath = String(relativePath || '').replace(/^\.\//, '');
  const lowerPath = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  const extension = path.posix.extname(lowerPath);

  if (
    lowerPath.includes('/node_modules/') || lowerPath.includes('/dist/') ||
    lowerPath.startsWith('node_modules/') || lowerPath.startsWith('dist/') ||
    INDEXED_SOURCE_BINARY_EXTENSIONS.has(extension)
  ) {
    return false;
  }

  if (normalizedPath.startsWith('src/')) {
    return INDEXED_SOURCE_TEXT_EXTENSIONS.has(extension);
  }

  return (
    normalizedPath === 'package.json' ||
    normalizedPath === 'index.html' ||
    /^vite\.config\.(?:js|mjs|ts|mts|cjs|cts)$/.test(basename) ||
    /^tailwind\.config\.(?:js|mjs|ts|mts|cjs|cts)$/.test(basename)
  );
}

function indexedFileKind(relativePath) {
  const normalizedPath = String(relativePath || '').replace(/^\.\//, '');
  const basename = path.posix.basename(normalizedPath).toLowerCase();

  if (normalizedPath === 'package.json') return 'package';
  if (normalizedPath === 'index.html') return 'html';
  if (basename.startsWith('vite.config.')) return 'vite-config';
  if (basename.startsWith('tailwind.config.')) return 'tailwind-config';
  if (normalizedPath.startsWith('src/components/')) return 'component';
  if (normalizedPath.startsWith('src/pages/')) return 'page';
  if (normalizedPath.startsWith('src/routes/')) return 'route';
  return 'source';
}

function decodeSourceFile(file) {
  if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') return '';
  return Buffer.from(file.content, 'base64').toString('utf8');
}

function extractComponentNames(indexedFiles) {
  const components = new Set();

  for (const file of indexedFiles) {
    if (!['component', 'page', 'route'].includes(file.kind)) continue;

    const basename = path.posix.basename(file.path).replace(/\.[^.]+$/, '');
    if (/^[A-Z][A-Za-z0-9]*$/.test(basename)) components.add(basename);

    for (const match of file.excerpt.matchAll(/(?:export\s+(?:default\s+)?(?:function|const|class)|function|const)\s+([A-Z][A-Za-z0-9]*)/g)) {
      components.add(match[1]);
    }
  }

  return [...components].slice(0, 12);
}

function extractRoutePaths(indexedFiles) {
  const routes = new Set();

  for (const file of indexedFiles) {
    if (file.kind === 'page') routes.add(file.path);
    if (file.kind !== 'route' && !/\b(?:Routes|Route|createBrowserRouter|path\s*:)/.test(file.excerpt)) continue;

    for (const match of file.excerpt.matchAll(/\bpath\s*:\s*["']([^"']+)/g)) {
      routes.add(match[1]);
    }
    for (const match of file.excerpt.matchAll(/<Route\b[^>]*\bpath\s*=\s*["']([^"']+)/g)) {
      routes.add(match[1]);
    }
  }

  return [...routes].slice(0, 12);
}

function createSourceContext(sourceFiles) {
  const kindPriority = {
    package: 0,
    html: 1,
    'vite-config': 2,
    'tailwind-config': 3,
    source: 4,
    route: 5,
    page: 6,
    component: 7,
  };
  const indexedFiles = (sourceFiles || [])
    .map((file) => ({ file, path: file.relativePath || file.path || '' }))
    .filter(({ path: relativePath }) => isUsefulSourceFile(relativePath))
    .sort((a, b) => {
      const kindDifference = kindPriority[indexedFileKind(a.path)] - kindPriority[indexedFileKind(b.path)];
      return kindDifference || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_INDEXED_SOURCE_FILES)
    .map(({ file, path: relativePath }) => {
      const content = decodeSourceFile(file);
      return {
        path: relativePath,
        kind: indexedFileKind(relativePath),
        size: Buffer.byteLength(content, 'utf8'),
        excerpt: content.slice(0, MAX_INDEXED_FILE_EXCERPT_CHARS),
      };
    });

  const packageFile = indexedFiles.find((file) => file.path === 'package.json');
  const packageExcerpt = packageFile ? packageFile.excerpt : '';
  const sourceText = indexedFiles.map((file) => file.excerpt).join('\n');
  const framework = /["']react["']\s*:|from\s+["']react["']/.test(sourceText)
    ? (/["']vite["']\s*:|vite\.config\./.test(`${packageExcerpt}\n${sourceText}`) ? 'React com Vite' : 'React')
    : (/["']vite["']\s*:|vite\.config\./.test(`${packageExcerpt}\n${sourceText}`) ? 'Vite' : 'não identificado');
  const mainFiles = indexedFiles
    .filter((file) => ['package', 'html', 'vite-config', 'tailwind-config'].includes(file.kind) || /\/main\.[jt]sx?$|\/App\.[jt]sx?$/.test(file.path))
    .map((file) => file.path)
    .slice(0, 10);
  const components = extractComponentNames(indexedFiles);
  const routes = extractRoutePaths(indexedFiles);
  const summary = [
    `Framework provável: ${framework}.`,
    `Arquivos principais: ${mainFiles.length ? mainFiles.join(', ') : 'não identificados'}.`,
    `Componentes encontrados: ${components.length ? components.join(', ') : 'nenhum identificado'}.`,
    `Rotas/páginas: ${routes.length ? routes.join(', ') : 'nenhuma rota identificada'}.`,
  ].join('\n');

  return { indexedFiles, sourceSummary: summary };
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
      const installEnv = { NODE_ENV: 'development', NPM_CONFIG_PRODUCTION: 'false' };
      logs += `${await runNpmCommand(['install', '--include=dev'], appRoot, { env: installEnv })}\n`;
      logs += `${await runNpmCommand(['install', 'react', 'react-dom'], appRoot, { env: installEnv })}\n`;
      logs += `${await runNpmCommand(['install', '-D', 'vite', '@vitejs/plugin-react', 'typescript', '@types/react', '@types/react-dom'], appRoot, { env: installEnv })}\n`;
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
    if (await fixDistIndexAssetPaths(distDir)) {
      logs += '\nAuto-fix aplicado: caminhos /assets/ corrigidos em dist/index.html.\n';
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
    await fs.mkdir(publicBuildDir, { recursive: true });
    await fs.cp(distDir, publicBuildDir, { recursive: true });

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
    console.error(`[react-vite-worker] job ${job._id} failed: ${error.message}`);
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
  console.error(`[react-vite-worker] fatal: ${error.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
