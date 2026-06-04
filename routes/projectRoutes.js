const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

function getEffectiveBuildStatus(project) {
  return project.generationStatus || project.generation_status || project.status || 'pending';
}

function buildProjectPayload(projectDocument) {
  const project =
    typeof projectDocument.toObject === 'function'
      ? projectDocument.toObject({ getters: true, virtuals: true })
      : projectDocument;
  const effectiveStatus = getEffectiveBuildStatus(project);
  const fullHtml = project.fullHtml || project.latestFullHtml || '';
  const build = project.build && typeof project.build === 'object' ? project.build : {};
  const payload = {
    success: true,
    status: effectiveStatus,
    generationStatus: effectiveStatus,
    generation_status: effectiveStatus,
    project,
  };

  if (effectiveStatus !== 'done') {
    return payload;
  }

  return {
    ...payload,
    response: project.response || '',
    summary: project.summary || '',
    html: project.html || '',
    css: project.css || '',
    js: project.js || '',
    fullHtml,
    latestFullHtml: project.latestFullHtml || fullHtml,
    distUrl: project.distUrl || build.distUrl || '',
    previewUrl: project.previewUrl || build.previewUrl || '',
    buildUrl: project.buildUrl || build.buildUrl || '',
    deploy: project.deploy || {},
    reactVite: project.reactVite === true || build.reactVite === true,
    build,
  };
}

function buildDoneProjectBuildPayload(project, buildDocument) {
  const build =
    typeof buildDocument.toObject === 'function'
      ? buildDocument.toObject({ getters: true, virtuals: true })
      : buildDocument;

  return {
    success: true,
    status: 'done',
    generationStatus: 'done',
    generation_status: 'done',
    project,
    build,
    html: build.html || '',
    css: build.css || '',
    js: build.js || '',
    fullHtml: build.fullHtml || '',
    latestFullHtml: build.fullHtml || '',
    distUrl: build.distUrl || '',
    previewUrl: build.previewUrl || '',
    deployUrl: build.deployUrl || '',
    sourceZipUrl: build.sourceZipUrl || '',
    logs: build.logs || '',
    reactVite: build.type === 'react_vite',
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.userId }).sort({
      createdAt: -1,
    });

    return res.json(projects);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Nome do projeto é obrigatório.' });
    }

    const project = await Project.create({
  userId: req.userId,
  name,
  description,
  status,
  prompt,
  type,
  settings,
});
    return res.status(201).json({
      message: 'Projeto criado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao criar projeto.',
      error: error.message,
    });
  }
});

router.get('/:id/build', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const latestDoneBuild = await ProjectBuild.findOne({
      projectId: project._id,
      status: 'done',
    }).sort({
      createdAt: -1,
      updatedAt: -1,
    });

    if (latestDoneBuild) {
      return res.json(buildDoneProjectBuildPayload(project, latestDoneBuild));
    }

    return res.json(buildProjectPayload(project));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar build do projeto.',
      error: error.message,
    });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(project);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projeto.',
      error: error.message,
    });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
      },
      {
        name,
        description,
        status,
        prompt,
        type,
        settings,
        


      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto atualizado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar projeto.',
      error: error.message,
    });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto excluído com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao excluir projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
