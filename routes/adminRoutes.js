const express = require('express');
const Project = require('../models/Project');

const router = express.Router();

router.get('/projects', async (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;

    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      return res.status(401).json({ message: 'Admin não autorizado' });
    }

    const projects = await Project.find().sort({
      updatedAt: -1,
      createdAt: -1,
    });

    return res.json({
      success: true,
      projects,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

module.exports = router;
