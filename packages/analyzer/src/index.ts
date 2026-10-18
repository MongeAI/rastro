export { analyzeProject, type AnalyzeOptions } from './analyze.js';
export {
  discoverFiles,
  DEFAULT_EXCLUDED_DIRS,
  languageOf,
  type DiscoverOptions,
  type DiscoveredFile,
} from './discover.js';
export { loadCompilerOptions, ModuleResolver, packageNameOf, isBuiltinModule } from './resolve.js';
