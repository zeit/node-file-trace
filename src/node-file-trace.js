const { extname, relative, resolve, sep } = require('path');
const sharedlibEmit = require('./utils/sharedlib-emit');
const fs = require('fs');
const analyze = require('./analyze');
const resolveDependency = require('./resolve-dependency');
const { isMatch } = require('micromatch');

const { gracefulify } = require('graceful-fs');
gracefulify(fs);

module.exports = async function (files, opts = {}) {
  const job = new Job(opts);

  if (opts.readFile)
    job.readFile = opts.readFile;
  if (opts.isDir)
    job.isDir = opts.isDir;

  job.ts = true;

  await Promise.all(files.map(file => {
    const path = resolve(file);
    job.emitFile(path, 'initial');
    if (path.endsWith('.js') || path.endsWith('.node') || job.ts && path.endsWith('.ts'))
      return job.emitDependency(path);
  }));

  return {
    fileList: [...job.fileList].sort(),
    esmFileList: [...job.esmFileList].sort(),
    reasons: job.reasons,
    warnings: [...job.warnings]
  };
};

class Job {
  constructor ({
    base,
    filterBase,
    ignore,
    log = false
  }) {
    if (base) {
      if (filterBase !== false) filterBase = true;
      base = resolve(base);
    }
    else {
      filterBase = false;
    }
    this.ignoreFn = path => {
      if (filterBase && path.startsWith('..' + sep)) return true;
      return false;
    };
    if (typeof ignore === 'string') ignore = [ignore];
    if (typeof ignore === 'function') {
      this.ignoreFn = path => {
        if (filterBase && path.startsWith('..' + sep)) return true;
        if (ignore(path)) return true;
        return false;
      };
    }
    else if (Array.isArray(ignore)) {
      const resolvedIgnores = ignore.map(ignore => relative(base, resolve(base || process.cwd(), ignore)));
      this.ignoreFn = path => {
        if (filterBase && path.startsWith('..' + sep)) return true;
        if (isMatch(path, resolvedIgnores)) return true;
        return false;
      }
    }
    this.base = base;
    this.log = log;
    this.reasons = Object.create(null);

    this.fileCache = new Map();
    this.isDirCache = new Map();

    this.fileList = new Set();
    this.esmFileList = new Set();
    this.processed = new Set();

    this.warnings = new Set();
  }

  isDir (path) {
    const cached = this.isDirCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const isDir = fs.statSync(path).isDirectory();
      this.isDirCache.set(path, isDir);
      return isDir;
    }
    catch (e) {
      if (e.code === 'ENOENT') {
        this.isDirCache.set(path, false);
        return false;
      }
      throw e;
    }
  }

  readFile (path) {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const source = fs.readFileSync(path).toString();
      this.fileCache.set(path, source);
      return source;
    }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') {
        this.fileCache.set(path, null);
        return null;
      }
      throw e;
    }
  }

  emitFile (path, reason, parent) {
    if (this.fileList.has(path)) return;
    if (this.base) {
      path = relative(this.base, path);
      if (parent)
        parent = relative(this.base, parent);
    }
    const reasonEntry = this.reasons[path] || (this.reasons[path] = {
      type: reason,
      ignored: false,
      parents: []
    });
    if (parent && reasonEntry.parents.indexOf(parent) === -1)
      reasonEntry.parents.push(parent);
    if (parent && this.ignoreFn(path, parent)) {
      if (reasonEntry) reasonEntry.ignored = true;
      return false;
    }
    this.fileList.add(path);
    return true;
  }

  async emitDependency (path, parent) {
    if (this.processed.has(path)) return;
    this.processed.add(path);

    const emitted = this.emitFile(path, 'dependency', parent);
    if (!emitted) return;
  
    if (path.endsWith('.json')) return;
    if (path.endsWith('.node')) return await sharedlibEmit(path, this);

    const source = this.readFile(path);
    if (source === null) throw new Error('File ' + path + ' does not exist.');

    const { deps, assets, isESM } = await analyze(path, source, this);
    if (isESM)
      this.esmFileList.add(this.base ? relative(this.base, path) : path);
    await Promise.all([
      ...[...assets].map(async asset => {
        const ext = extname(asset);
        if (ext === '.js' || ext === '.mjs' || ext === '.node' || ext === '' ||
            this.ts && ext === '.ts' && asset.startsWith(this.base) && asset.substr(this.base.length).indexOf(sep + 'node_modules' + sep) === -1)
          await this.emitDependency(asset, path);
        else
          this.emitFile(asset, 'asset', path);
      }),
      ...[...deps].map(async dep => {
        try {
          var { real, symlink } = await resolveDependency(dep, path, this);
          // ignore builtins
          if (real.startsWith('node:')) return;
        }
        catch (e) {
          this.warnings.add(e);
          return;
        }
        await this.emitDependency(real, path);
        if (symlink) {
          await this.emitDependency(symlink, path);
        }
      })
    ])
  }
}
