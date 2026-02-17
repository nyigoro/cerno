"use strict";

const { analyseCSS, findNodeBySelector, findManifest } = require("./dist/src/analyser");
const { renderReport, toJSON } = require("./dist/src/reporter");
const {
  emitComponentSection,
  assembleBinary,
  fnv1a32,
  RecordType,
  STATIC_MAGIC,
  DYNAMIC_MAGIC,
  FILE_MAGIC,
  FILE_VERSION,
} = require("./dist/src/emitter");
const {
  collectFallbackRules,
  emitFallbackCss,
} = require("./dist/src/fallbackEmitter");
const {
  PoolBuilder,
  PoolReader,
  buildPoolFromAnalysis,
  NULL_REF,
  POOL_MAGIC,
  POOL_VERSION,
  COMMON_CSS_PROPERTIES,
} = require("./dist/src/constantPool");
const {
  SOMLoader,
  loadSOM,
  ResolvedProperties,
  BoundaryManifest,
  RuleSetRecord,
  NondeterministicRecord,
} = require("./dist/src/loader");
const {
  SOMLoaderBrowser,
} = require("./dist/src/browserLoader");
const {
  SOMRuntime,
} = require("./dist/src/runtime");
const {
  SubscriptionManager,
} = require("./dist/src/subscriptionManager");
const { binarySomPlugin } = require("./dist/src/vitePlugin");
const { BinarySomPlugin } = require("./dist/src/webpackPlugin");
const { SOMWatcher, computeDiff, formatDiff, snapshotResult } = require("./dist/src/watcher");

module.exports = {
  analyseCSS,
  findNodeBySelector,
  findManifest,
  renderReport,
  toJSON,
  emitComponentSection,
  assembleBinary,
  collectFallbackRules,
  emitFallbackCss,
  fnv1a32,
  RecordType,
  STATIC_MAGIC,
  DYNAMIC_MAGIC,
  FILE_MAGIC,
  FILE_VERSION,
  PoolBuilder,
  PoolReader,
  buildPoolFromAnalysis,
  NULL_REF,
  POOL_MAGIC,
  POOL_VERSION,
  COMMON_CSS_PROPERTIES,
  SOMLoader,
  loadSOM,
  ResolvedProperties,
  BoundaryManifest,
  RuleSetRecord,
  NondeterministicRecord,
  SOMLoaderBrowser,
  SOMRuntime,
  SubscriptionManager,
  binarySomPlugin,
  BinarySomPlugin,
  SOMWatcher,
  computeDiff,
  formatDiff,
  snapshotResult,
};


