import { Reporter } from '../Reporter';
import { Resource, CleanupResult } from '../../types';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as winston from 'winston';

// Arbitraries for generating test data
const resourceArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  type: fc.oneof(
    fc.constant('container' as const),
    fc.constant('image' as const),
    fc.constant('volume' as const),
    fc.constant('network' as const)
  ),
  size: fc.nat({ max: 1000000000 }),
  createdAt: fc.date(),
  tags: fc.array(fc.string())
});

const cleanupErrorArbitrary = fc.record({
  type: fc.oneof(
    fc.constant('authentication' as const),
    fc.constant('network' as const),
    fc.constant('permission' as const),
    fc.constant('resource_in_use' as const),
    fc.constant('resource_not_found' as const),
    fc.constant('filesystem' as const),
    fc.constant('unknown' as const)
  ),
  message: fc.string({ minLength: 1 }),
  timestamp: fc.date(),
  recoverable: fc.boolean(),
  resource: fc.option(resourceArbitrary, { nil: undefined })
});

const cleanupResultArbitrary = fc.record({
  removed: fc.array(resourceArbitrary, { maxLength: 10 }),
  skipped: fc.array(resourceArbitrary, { maxLength: 10 }),
  errors: fc.array(cleanupErrorArbitrary, { maxLength: 5 }),
  diskSpaceFreed: fc.nat({ max: 10000000000 }),
  executionTime: fc.nat({ max: 300000 })
});

describe('Reporter Property Tests', () => {
  let reporter: Reporter;
  let testLogPath: string;

  beforeEach(() => {
    // Create temporary log directory for testing
    testLogPath = path.join(__dirname, 'test-logs', `test-${Date.now()}`);
    reporter = new Reporter(testLogPath);
  });

  afterEach(async () => {
    // Clean up test log directory
    try {
      if (fs.existsSync(testLogPath)) {
        await fs.promises.rm(testLogPath, { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Property 8: Report Consistency', () => {
    // Feature: proxmox-cleanup, Property 8: Report Consistency
    // Validates: Requirements 10.1, 10.2
    it('should ensure total resources equals removed + skipped + errors', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            scannedResources: fc.array(resourceArbitrary, { minLength: 1, maxLength: 20 }),
            result: cleanupResultArbitrary,
            mode: fc.oneof(fc.constant('dry-run' as const), fc.constant('cleanup' as const)),
            executionTime: fc.nat({ max: 300000 })
          }),
          async (testData) => {
            const { scannedResources, result, mode, executionTime } = testData;

            // Generate report
            const report = reporter.generateReport(mode, scannedResources, result, executionTime);

            // Property: Report should contain all input data
            expect(report.mode).toBe(mode);
            expect(report.summary.resourcesScanned).toBe(scannedResources.length);
            expect(report.summary.resourcesRemoved).toBe(result.removed.length);
            expect(report.summary.diskSpaceFreed).toBe(result.diskSpaceFreed);
            expect(report.summary.executionTime).toBe(executionTime);

            // Property: Details should match input
            expect(report.details.removed).toEqual(result.removed);
            expect(report.details.skipped).toEqual(result.skipped);
            expect(report.details.errors).toEqual(result.errors);

            // Property: Report should have a valid timestamp
            expect(report.timestamp).toBeInstanceOf(Date);
            expect(report.timestamp.getTime()).toBeLessThanOrEqual(Date.now());

            // Property: Summary counts should be consistent
            const totalProcessed = result.removed.length + result.skipped.length + result.errors.length;
            expect(totalProcessed).toBeGreaterThanOrEqual(0);
            expect(report.summary.resourcesRemoved).toBe(result.removed.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should generate consistent summaries for the same report', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            scannedResources: fc.array(resourceArbitrary, { maxLength: 10 }),
            result: cleanupResultArbitrary,
            mode: fc.oneof(fc.constant('dry-run' as const), fc.constant('cleanup' as const)),
            executionTime: fc.nat({ max: 300000 })
          }),
          async (testData) => {
            const { scannedResources, result, mode, executionTime } = testData;

            // Generate report
            const report = reporter.generateReport(mode, scannedResources, result, executionTime);

            // Generate summary multiple times
            const summary1 = reporter.generateSummary(report);
            const summary2 = reporter.generateSummary(report);

            // Property: Summaries should be identical
            expect(summary1).toBe(summary2);

            // Property: Summary should contain key information
            expect(summary1).toContain(mode.toUpperCase());
            expect(summary1).toContain(`Resources Scanned: ${scannedResources.length}`);
            expect(summary1).toContain(`${mode === 'dry-run' ? 'Would Be ' : ''}Removed: ${result.removed.length}`);

            // Property: Summary should be non-empty
            expect(summary1.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should maintain data integrity when saving and loading reports', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            scannedResources: fc.array(resourceArbitrary, { maxLength: 5 }),
            result: cleanupResultArbitrary,
            mode: fc.oneof(fc.constant('dry-run' as const), fc.constant('cleanup' as const)),
            executionTime: fc.nat({ max: 300000 })
          }),
          async (testData) => {
            const { scannedResources, result, mode, executionTime } = testData;

            // Generate report
            const originalReport = reporter.generateReport(mode, scannedResources, result, executionTime);

            // Save report to file
            const filePath = await reporter.saveReport(originalReport);

            // Verify file exists
            expect(fs.existsSync(filePath)).toBe(true);

            // Load report from file
            const fileContent = await fs.promises.readFile(filePath, 'utf8');
            const loadedReport = JSON.parse(fileContent);

            // Property: Loaded report should match original (accounting for JSON serialization)
            expect(loadedReport.mode).toBe(originalReport.mode);
            expect(loadedReport.summary).toEqual(originalReport.summary);

            // Handle Date serialization in resources
            const compareResources = (loaded: any[], original: Resource[]) => {
              expect(loaded).toHaveLength(original.length);
              loaded.forEach((loadedResource: any, index: number) => {
                const originalResource = original[index];
                expect(loadedResource.id).toBe(originalResource.id);
                expect(loadedResource.name).toBe(originalResource.name);
                expect(loadedResource.type).toBe(originalResource.type);
                expect(loadedResource.size).toBe(originalResource.size);
                expect(loadedResource.tags).toEqual(originalResource.tags);
                // createdAt becomes string after JSON serialization
                expect(new Date(loadedResource.createdAt)).toEqual(originalResource.createdAt);
              });
            };

            compareResources(loadedReport.details.removed, originalReport.details.removed);
            compareResources(loadedReport.details.skipped, originalReport.details.skipped);

            // For errors, we need to handle the fact that undefined values are removed during JSON serialization
            expect(loadedReport.details.errors).toHaveLength(originalReport.details.errors.length);
            loadedReport.details.errors.forEach((loadedError: any, index: number) => {
              const originalError = originalReport.details.errors[index];
              expect(loadedError.type).toBe(originalError.type);
              expect(loadedError.message).toBe(originalError.message);
              expect(loadedError.recoverable).toBe(originalError.recoverable);
              // timestamp becomes string after JSON serialization
              expect(new Date(loadedError.timestamp)).toEqual(originalError.timestamp);
              // resource field may be undefined and gets removed during JSON serialization
              if (originalError.resource) {
                expect(loadedError.resource).toBeDefined();
                expect(loadedError.resource.id).toBe(originalError.resource.id);
                expect(loadedError.resource.name).toBe(originalError.resource.name);
                expect(loadedError.resource.type).toBe(originalError.resource.type);
                expect(new Date(loadedError.resource.createdAt)).toEqual(originalError.resource.createdAt);
              }
            });

            // Property: Timestamp should be preserved (as string)
            expect(new Date(loadedReport.timestamp)).toEqual(originalReport.timestamp);
          }
        ),
        { numRuns: 50 } // Reduced runs due to file I/O
      );
    });
  });

  describe('Report Generation Edge Cases', () => {
    it('should handle empty resource lists', async () => {
      const emptyResult: CleanupResult = {
        removed: [],
        skipped: [],
        errors: [],
        diskSpaceFreed: 0,
        executionTime: 1000
      };

      const report = reporter.generateReport('dry-run', [], emptyResult, 1000);

      expect(report.summary.resourcesScanned).toBe(0);
      expect(report.summary.resourcesRemoved).toBe(0);
      expect(report.summary.diskSpaceFreed).toBe(0);
      expect(report.details.removed).toHaveLength(0);
      expect(report.details.skipped).toHaveLength(0);
      expect(report.details.errors).toHaveLength(0);

      const summary = reporter.generateSummary(report);
      expect(summary).toContain('Resources Scanned: 0');
      expect(summary).toContain('No failures.');
    });

    it('should handle reports with only errors', async () => {
      const errorOnlyResult: CleanupResult = {
        removed: [],
        skipped: [],
        errors: [
          {
            type: 'network',
            message: 'Connection failed',
            timestamp: new Date(),
            recoverable: true
          }
        ],
        diskSpaceFreed: 0,
        executionTime: 2000
      };

      const report = reporter.generateReport('cleanup', [], errorOnlyResult, 2000);

      expect(report.summary.resourcesRemoved).toBe(0);
      expect(report.details.errors).toHaveLength(1);

      const summary = reporter.generateSummary(report);
      expect(summary).toContain('ERRORS:');
      expect(summary).toContain('Failed to remove: 1 of 1 attempted');
    });

    it('counts only real failures, never intentional skips', async () => {
      const mixedResult: CleanupResult = {
        removed: [
          { id: '1', name: 'container1', type: 'container', size: 1000, createdAt: new Date(), tags: [] } as Resource
        ],
        skipped: [
          { id: '2', name: 'container2', type: 'container', size: 2000, createdAt: new Date(), tags: [] } as Resource
        ],
        errors: [
          {
            type: 'resource_in_use',
            message: 'Resource in use',
            timestamp: new Date(),
            recoverable: false
          }
        ],
        diskSpaceFreed: 1000,
        executionTime: 3000
      };

      const report = reporter.generateReport('cleanup', [], mixedResult, 3000);
      const summary = reporter.generateSummary(report);

      // 1 removed, 1 error => "1 of 2 attempted". The skipped resource is the
      // tool working correctly (still in use), so it must NOT count as a
      // failure — the old "Success Rate: 33.3%" told a user with protected
      // resources that two thirds of their clean run had failed.
      expect(summary).toContain('Failed to remove: 1 of 2 attempted');
      expect(summary).not.toContain('Success Rate');
      expect(summary).toContain('SKIPPED RESOURCES (left alone on purpose):');
    });
  });

  describe('File Operations', () => {
    it('should create log directory if it does not exist', async () => {
      const nonExistentPath = path.join(__dirname, 'non-existent-logs', `test-${Date.now()}`);
      const reporterWithNewPath = new Reporter(nonExistentPath);

      const report = reporterWithNewPath.generateReport('dry-run', [], {
        removed: [],
        skipped: [],
        errors: [],
        diskSpaceFreed: 0,
        executionTime: 1000
      }, 1000);

      await reporterWithNewPath.saveReport(report);

      expect(fs.existsSync(nonExistentPath)).toBe(true);

      // Cleanup
      await fs.promises.rm(nonExistentPath, { recursive: true, force: true });
    });

    it('should generate unique filenames for reports', async () => {
      const report1 = reporter.generateReport('dry-run', [], {
        removed: [],
        skipped: [],
        errors: [],
        diskSpaceFreed: 0,
        executionTime: 1000
      }, 1000);

      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      const report2 = reporter.generateReport('cleanup', [], {
        removed: [],
        skipped: [],
        errors: [],
        diskSpaceFreed: 0,
        executionTime: 2000
      }, 2000);

      const filePath1 = await reporter.saveReport(report1);
      const filePath2 = await reporter.saveReport(report2);

      expect(filePath1).not.toBe(filePath2);
      expect(fs.existsSync(filePath1)).toBe(true);
      expect(fs.existsSync(filePath2)).toBe(true);
    });
  });

  describe('Reporter console silencing', () => {
    it('silences the Console transport when silentConsole is true, keeps file transports', () => {
      const reporter = new Reporter('./logs', true);
      const logger = reporter.getLogger();
      const consoleTransport = logger.transports.find(
        t => t instanceof winston.transports.Console
      ) as winston.transports.ConsoleTransportInstance;
      const fileTransports = logger.transports.filter(
        t => t instanceof winston.transports.File
      );
      expect(consoleTransport.silent).toBe(true);
      expect(fileTransports.length).toBe(2);
    });

    it('leaves the Console transport audible by default', () => {
      const reporter = new Reporter('./logs');
      const logger = reporter.getLogger();
      const consoleTransport = logger.transports.find(
        t => t instanceof winston.transports.Console
      ) as winston.transports.ConsoleTransportInstance;
      expect(consoleTransport.silent).toBeFalsy();
    });
  });

  describe('Reporter skippedUnknownAge surface', () => {
    const reporter = new Reporter('./logs', true); // silent console for test noise

    const baseResult = (over: Partial<CleanupResult>): CleanupResult => ({
      removed: [], skipped: [], errors: [], diskSpaceFreed: 0, executionTime: 0, ...over
    });

    it('carries skippedUnknownAge into the report details', () => {
      const vol = { id: 'v', name: 'v', type: 'volume' as const, size: 0, tags: [] };
      const result = baseResult({
        removed: [{ id: 'i', name: 'i', type: 'image', size: 5, tags: [] }],
        skippedUnknownAge: [vol]
      });
      const report = reporter.generateReport('cleanup', [], result, 1);
      expect(report.details.skippedUnknownAge).toEqual([vol]);
    });

    it('excludes unknown-age resources from the failure count', () => {
      const removed = [{ id: 'i', name: 'i', type: 'image' as const, size: 5, tags: [] }];
      const unknown = Array.from({ length: 9 }, (_, n) => ({
        id: `v${n}`, name: `v${n}`, type: 'volume' as const, size: 0, tags: []
      }));
      const report = reporter.generateReport('cleanup', [], baseResult({ removed, skippedUnknownAge: unknown }), 1);
      // 9 undated volumes were skipped on purpose, not failures.
      expect(reporter.generateSummary(report)).toContain('No failures.');
    });
  });

  // The installer's logrotate rule only matches *.log, so nothing else bounds
  // these files. Unbounded, a daily timer writes 730 pairs a year — a
  // disk-cleanup tool leaking disk.
  describe('report retention', () => {
    const emptyResult = {
      removed: [], skipped: [], errors: [], diskSpaceFreed: 0, executionTime: 0
    };

    it('keeps only the newest report/summary pairs', async () => {
      const bounded = new Reporter(testLogPath, true, 3);

      for (let i = 0; i < 6; i++) {
        // Distinct timestamps drive distinct filenames.
        const report = bounded.generateReport('cleanup', [], emptyResult, 0);
        report.timestamp = new Date(Date.UTC(2026, 0, i + 1));
        await bounded.saveReport(report);
        await bounded.saveSummary(report);
      }

      const files = await fs.promises.readdir(testLogPath);
      expect(files.filter(f => f.startsWith('cleanup-report-'))).toHaveLength(3);
      expect(files.filter(f => f.startsWith('cleanup-summary-'))).toHaveLength(3);
      // winston owns the .log files; pruning must not touch them.
      expect(files).toContain('cleanup.log');
    });

    it('does not let dry-run previews evict the record of a real cleanup', async () => {
      // Retention is per mode. Sharing one budget meant a few previews pushed
      // out the report of what a cleanup had actually deleted.
      const bounded = new Reporter(testLogPath, true, 2);

      const write = async (mode: 'cleanup' | 'dry-run', day: number) => {
        const report = bounded.generateReport(mode, [], emptyResult, 0);
        report.timestamp = new Date(Date.UTC(2026, 7, day));
        await bounded.saveReport(report);
      };

      await write('cleanup', 1);
      for (const day of [2, 3, 4, 5]) await write('dry-run', day);

      const reports = (await fs.promises.readdir(testLogPath))
        .filter(f => f.startsWith('cleanup-report-'));

      expect(reports.filter(f => f.includes('-cleanup-'))).toHaveLength(1);
      expect(reports.filter(f => f.includes('-dry-run-'))).toHaveLength(2);
    });

    it('keeps the most recent pair, not an arbitrary one', async () => {
      const bounded = new Reporter(testLogPath, true, 1);

      for (const day of [1, 2, 3]) {
        const report = bounded.generateReport('cleanup', [], emptyResult, 0);
        report.timestamp = new Date(Date.UTC(2026, 0, day));
        await bounded.saveReport(report);
      }

      const reports = (await fs.promises.readdir(testLogPath))
        .filter(f => f.startsWith('cleanup-report-'));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain('2026-01-03');
    });
  });
});
