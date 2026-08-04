const express = require('express');
const FluidAvailability = require('../models/FluidAvailability');
const authMiddleware = require('../middleware/authMiddleware');

const { FLUID_AVAILABILITY_KEY } = FluidAvailability;

const router = express.Router();

function serializeAvailability(record) {
  return {
    ok: true,
    isOnline: record?.isOnline !== false,
  };
}

async function getAvailabilityRecord() {
  return FluidAvailability.findOne({ key: FLUID_AVAILABILITY_KEY }).lean();
}

async function readAvailability(req, res) {
  try {
    const record = await getAvailabilityRecord();
    return res.json(serializeAvailability(record));
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
