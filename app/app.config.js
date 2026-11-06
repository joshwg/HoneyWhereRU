// Dynamic Expo config: everything comes from app.json except the version,
// which is read from the repo-root VERSION file shared with the server.
const fs = require('fs');
const path = require('path');

const version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();

module.exports = ({ config }) => ({ ...config, version });
