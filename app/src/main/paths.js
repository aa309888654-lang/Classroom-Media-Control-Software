const path = require('path');
const { app } = require('electron');

// 打包后 extraResources 落在 process.resourcesPath/resources；开发态在工程 resources/
function getResourcesPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources')
    : path.join(app.getAppPath(), 'resources');
}

module.exports = { getResourcesPath };
