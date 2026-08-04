const FluidAvailability = require('../models/FluidAvailability');

const { FLUID_AVAILABILITY_KEY } = FluidAvailability;
const FLUID_OFFLINE_CODE = 'FLUID_OFFLINE';
const FLUID_OFFLINE_MESSAGE = 'Fluid is temporarily unavailable. Please check back soon.';

function serializeAvailability(record) {
  return {
    ok: true,
    isOnline: record?.isOnline !== false,
  };
}

function buildFluidOfflinePayload() {
  return {
    ok: false,
    code: FLUID_OFFLINE_CODE,
    message: FLUID_OFFLINE_MESSAGE,
  };
}

async function getAvailabilityRecord() {
  return FluidAvailability.findOne({ key: FLUID_AVAILABILITY_KEY }).lean();
}

async function readFluidAvailability() {
  const record = await getAvailabilityRecord();
  return serializeAvailability(record);
}

function sendFluidOffline(res) {
  return res.status(503).json(buildFluidOfflinePayload());
}

async function ensureFluidOnlineForNewWork(res) {
  try {
    const availability = await readFluidAvailability();
    if (availability.isOnline !== false) return true;
  } catch (error) {
    // New generation fails closed, but read-only application access is unaffected.
  }

  sendFluidOffline(res);
  return false;
}

module.exports = {
  FLUID_AVAILABILITY_KEY,
  FLUID_OFFLINE_CODE,
  FLUID_OFFLINE_MESSAGE,
  buildFluidOfflinePayload,
  ensureFluidOnlineForNewWork,
  getAvailabilityRecord,
  readFluidAvailability,
  sendFluidOffline,
  serializeAvailability,
};
