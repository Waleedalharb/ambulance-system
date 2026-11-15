'use strict';

class RegionCommandError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'RegionCommandError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = { RegionCommandError };
