const express = require('express');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { projectId, message } = req.body;

    const project = await Project.findOne({
      _id: projectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      reply: `Recebi sua solicitação: ${message}`,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao processar chat.',
      error: error.message,
    });
  }
});

module.exports = router;
