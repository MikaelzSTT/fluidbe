const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getAvailabilityRecord,
  readFluidAvailability,
  serializeAvailability,
} = require('../utils/fluidAvailability');

const router = express.Router();

async function readAvailability(req, res) {
  try {
    return res.json(await readFluidAvailability());
  } catch (error) {
    return res.status(500).json({
      ok: false,
      code: 'FLUID_AVAILABILITY_READ_FAILED',
      message: 'Não foi possível carregar a disponibilidade do Fluid.',
    });
  }
}

router.get('/availability', authMiddleware, readAvailability);

module.exports = router;
module.exports.getAvailabilityRecord = getAvailabilityRecord;
module.exports.readAvailability = readAvailability;
module.exports.serializeAvailability = serializeAvailability;
