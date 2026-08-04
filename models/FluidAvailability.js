const mongoose = require('mongoose');

const FLUID_AVAILABILITY_KEY = 'global';

const fluidAvailabilitySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      enum: [FLUID_AVAILABILITY_KEY],
      default: FLUID_AVAILABILITY_KEY,
    },
    isOnline: {
      type: Boolean,
      required: true,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FluidAvailability', fluidAvailabilitySchema);
module.exports.FLUID_AVAILABILITY_KEY = FLUID_AVAILABILITY_KEY;
