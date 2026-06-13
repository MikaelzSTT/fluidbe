const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const chatRoutes = require('./routes/chatRoutes');
const adminRoutes = require('./routes/adminRoutes');
const Project = require('./models/Project');
const ProjectBuild = require('./models/ProjectBuild');


dotenv.config();

const app = express();

const PUBLIC_BUILDS_DIR = path.join(__dirname, 'public', 'builds');
const allowedOrigins = [
  'https://askfluid.now',
  'https://www.askfluid.now',
  'https://fluid-web-static.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173'
];
const corsOptions = {
  origin: allowedOrigins,
  credentials: true
};

function resolvePublicBuildIndexPath(buildUrl) {
  if (typeof buildUrl !== 'string') {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(new URL(buildUrl, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const relativeBuildPath = pathname.slice('/builds/'.length);
  const requestedPath = path.basename(relativeBuildPath) === 'index.html'
    ? relativeBuildPath
    : path.join(relativeBuildPath, 'index.html');
  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);
  const indexPath = path.resolve(buildsRoot, requestedPath);

  if (indexPath !== buildsRoot && !indexPath.startsWith(`${buildsRoot}${path.sep}`)) {
    return null;
  }

  return indexPath;
}

function rewriteBuildAssetPaths(html, buildUrl) {
  const buildPath = new URL(buildUrl, 'http://localhost').pathname;
  const buildBasePath = buildPath.endsWith('/index.html')
    ? buildPath.slice(0, -'index.html'.length)
    : `${buildPath.replace(/\/+$/, '')}/`;

  return html
    .replaceAll('src="./assets/', `src="${buildBasePath}assets/`)
    .replaceAll("src='./assets/", `src='${buildBasePath}assets/`)
    .replaceAll('href="./assets/', `href="${buildBasePath}assets/`)
    .replaceAll("href='./assets/", `href='${buildBasePath}assets/`)
    .replaceAll('url(./assets/', `url(${buildBasePath}assets/`)
    .replaceAll('url("./assets/', `url("${buildBasePath}assets/`)
    .replaceAll("url('./assets/", `url('${buildBasePath}assets/`);
}

function parseBuildRequestPath(requestPath) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(requestPath, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const parts = pathname.slice('/builds/'.length).split('/').filter(Boolean);

  if (parts.length < 2 || !mongoose.Types.ObjectId.isValid(parts[0])) {
    return null;
  }

  const projectId = parts[0];
  const buildKey = parts[1];
  const artifactPath = parts.slice(2).join('/') || 'index.html';
  const indexBuildUrl = `/builds/${projectId}/${buildKey}/index.html`;

  if (artifactPath.includes('..')) {
    return null;
  }

  return {
    projectId,
    buildKey,
    artifactPath,
    indexBuildUrl,
  };
}

async function findMongoBuildArtifact(requestPath) {
  const parsedPath = parseBuildRequestPath(requestPath);

  if (!parsedPath) {
    return null;
  }

  const escapedIndexBuildUrl = parsedPath.indexBuildUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absoluteIndexBuildUrlPattern = new RegExp(`${escapedIndexBuildUrl}$`);
  const build = await ProjectBuild.findOne({
    projectId: parsedPath.projectId,
    $or: [
      { distUrl: parsedPath.indexBuildUrl },
      { previewUrl: parsedPath.indexBuildUrl },
      { buildUrl: parsedPath.indexBuildUrl },
      { deployUrl: parsedPath.indexBuildUrl },
      { distUrl: absoluteIndexBuildUrlPattern },
      { previewUrl: absoluteIndexBuildUrlPattern },
      { buildUrl: absoluteIndexBuildUrlPattern },
      { deployUrl: absoluteIndexBuildUrlPattern },
    ],
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  });

  if (!build) {
    return null;
  }

  const artifact = Array.isArray(build.artifactFiles)
    ? build.artifactFiles.find((file) => file.path === parsedPath.artifactPath)
    : null;

  if (artifact && artifact.content) {
    return {
      contentType: artifact.contentType || 'application/octet-stream',
      body: Buffer.from(artifact.content, artifact.encoding || 'base64'),
    };
  }

  if (parsedPath.artifactPath === 'index.html' && (build.fullHtml || build.html)) {
    return {
      contentType: 'text/html; charset=utf-8',
      body: build.fullHtml || build.html,
    };
  }

  return null;
}

async function loadPublishedHtml(project) {
  const latestDoneBuild = await ProjectBuild.findOne({
    projectId: project._id,
    status: 'done',
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  });
  const build = latestDoneBuild || {};
  const inlineHtml =
    build.fullHtml ||
    build.html ||
    project.fullHtml ||
    project.latestFullHtml ||
    project.html ||
    '';

  if (inlineHtml) {
    return inlineHtml;
  }

  const buildUrl = build.buildUrl || build.deployUrl || build.previewUrl || build.distUrl || project.buildUrl || '';
  const indexPath = resolvePublicBuildIndexPath(buildUrl);

  if (!indexPath) {
    return '';
  }

  const fileHtml = await fs.readFile(indexPath, 'utf8');
  return rewriteBuildAssetPaths(fileHtml, buildUrl);
}

app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use('/builds', express.static(path.join(__dirname, 'public', 'builds')));
app.get(/^\/builds\/.+$/, async (req, res, next) => {
  try {
    const artifact = await findMongoBuildArtifact(req.path);

    if (!artifact) {
      return next();
    }

    return res.type(artifact.contentType).send(artifact.body);
  } catch (error) {
    return next(error);
  }
});
app.get('/p/:slug', async (req, res) => {
  try {
    const project = await Project.findOne({
      slug: req.params.slug,
      isPublished: true,
    });

    if (!project) {
      return res.status(404).send('Projeto não encontrado.');
    }

    const html = await loadPublishedHtml(project);

    if (!html) {
      return res.status(404).send('Projeto não encontrado.');
    }

    return res.type('html').send(html);
  } catch (error) {
    return res.status(500).send('Erro ao carregar projeto publicado.');
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB conectado');
  })
  .catch((err) => {
    console.error('Erro MongoDB:', err);
  });

app.get('/', (req, res) => {
  res.json({
    message: 'FLUIDBE backend rodando',
    database: 'conectada',
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
