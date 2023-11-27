class ApiError extends Error {
  /**
   * Initialize function
   * @param {String} message Error message
   * @param {Number} statusCode API Error Code
   */
  constructor(message = '', statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }

  getStatusCode() {
    return this.statusCode;
  }

  getMessage() {
    return this.message;
  }
}

module.exports = ApiError;