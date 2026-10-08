// permissionless 0.3.5 uses the Ox 0.11 API for WebAuthn. Its optional peer
// otherwise inherits the SDK's incompatible Ox 1.x dependency in this workspace.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'permissionless' && pkg.version === '0.3.5') {
        pkg.dependencies = { ...pkg.dependencies, ox: '0.11.3' };
        delete pkg.peerDependencies.ox;
        delete pkg.peerDependenciesMeta.ox;
      }
      return pkg;
    },
  },
};
