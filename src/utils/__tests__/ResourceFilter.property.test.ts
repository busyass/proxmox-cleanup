import * as fc from 'fast-check';
import { ResourceFilter } from '../ResourceFilter';
import { Resource } from '../../types';

// Feature: proxmox-cleanup, Property 5: Protected Resource Exclusion
// Validates: Requirements 9.1, 9.2

describe('ResourceFilter Property Tests', () => {
  it('should never include protected resources in filtered results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          // Generate resources
          fc.array(
            fc.record({
              id: fc.hexaString({ minLength: 12, maxLength: 64 }),
              name: fc.string({ minLength: 1, maxLength: 20 }),
              type: fc.constantFrom('container', 'image', 'volume', 'network'),
              size: fc.nat(),
              createdAt: fc.date(),
              tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 5 })
            }),
            { minLength: 5, maxLength: 20 }
          ),
          // Generate protection patterns
          fc.array(
            fc.string({ minLength: 1, maxLength: 20 }),
            { minLength: 1, maxLength: 5 }
          )
        ),
        async ([resources, patterns]) => {
          const filter = new ResourceFilter(patterns);
          const filtered = filter.filterProtected(resources as Resource[]);

          // Property: No filtered resource should match any protection pattern
          const allSafe = filtered.every(resource => !filter.isProtected(resource));

          // Property: All protected resources should be excluded from filtered results
          const protectedResources = filter.getProtected(resources as Resource[]);
          const noProtectedInFiltered = protectedResources.every(
            protectedResource => !filtered.some(r => r.id === protectedResource.id)
          );

          expect(allSafe).toBe(true);
          expect(noProtectedInFiltered).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should correctly match wildcard patterns', async () => {
    await fc.assert(
      fc.asyncProperty(
        // No wildcard, blank or padding in the literal parts: "*" would build
        // the pattern "**" and padding is trimmed on the way in, both of which
        // contradict the guard below.
        fc.record({
          prefix: fc.stringMatching(/^[^*\s]{1,10}$/),
          suffix: fc.stringMatching(/^[^*\s]{1,10}$/),
          middle: fc.stringMatching(/^[^*\s]{1,10}$/)
        }),
        async ({ prefix, suffix, middle }) => {
          const pattern = `${prefix}*`;
          const matchingName = `${prefix}${middle}`;
          const nonMatchingName = `${suffix}${middle}`;

          const filter = new ResourceFilter([pattern]);

          const matchingResource: Resource = {
            id: '123',
            name: matchingName,
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: []
          };

          const nonMatchingResource: Resource = {
            id: '456',
            name: nonMatchingName,
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: []
          };

          // Property: Resources matching wildcard pattern should be protected
          expect(filter.isProtected(matchingResource)).toBe(true);

          // Property: Resources not matching wildcard pattern should not be protected
          if (!nonMatchingName.startsWith(prefix)) {
            expect(filter.isProtected(nonMatchingResource)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should correctly match tag-based protection', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Docker label keys are never blank or padded, and patterns are
        // trimmed on the way in, so a whitespace-only tag is not a case the
        // filter is meant to match.
        fc.tuple(
          fc.stringMatching(/^\S{1,10}$/),
          fc.array(fc.stringMatching(/^\S{1,10}$/), { minLength: 1, maxLength: 5 })
        ),
        async ([protectedTag, otherTags]) => {
          const pattern = `tag:${protectedTag}`;
          const filter = new ResourceFilter([pattern]);

          const resourceWithTag: Resource = {
            id: '123',
            name: 'test-resource',
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: [protectedTag, ...otherTags]
          };

          const resourceWithoutTag: Resource = {
            id: '456',
            name: 'test-resource-2',
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: otherTags.filter(t => t !== protectedTag)
          };

          // Property: Resources with protected tag should be protected
          expect(filter.isProtected(resourceWithTag)).toBe(true);

          // Property: Resources without protected tag should not be protected
          if (!otherTags.includes(protectedTag)) {
            expect(filter.isProtected(resourceWithoutTag)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should correctly match ID-based protection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.hexaString({ minLength: 12, maxLength: 64 }),
        async (protectedId) => {
          const pattern = `id:${protectedId}`;
          const filter = new ResourceFilter([pattern]);

          const resourceWithId: Resource = {
            id: protectedId,
            name: 'test-resource',
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: []
          };

          const resourceWithDifferentId: Resource = {
            id: 'different-id-123',
            name: 'test-resource-2',
            type: 'container',
            size: 100,
            createdAt: new Date(),
            tags: []
          };

          // Property: Resource with protected ID should be protected
          expect(filter.isProtected(resourceWithId)).toBe(true);

          // Property: Resource with different ID should not be protected
          expect(filter.isProtected(resourceWithDifferentId)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // A pattern that matches nothing is worse than no pattern: the user believes
  // the resource is safe and it gets deleted.
  describe('patterns the user can actually type', () => {
    const fullId = 'sha256:ec3f0931a6e6b6855d76b2d7b0be30e81860baccd891b2e243280bf1cd8ad710';
    const dangling = (): Resource => ({
      id: fullId,
      name: '<none>:<none> (ec3f0931a6e6)',
      type: 'image',
      size: 1,
      tags: ['env', 'env=production']
    });

    it('protects by the short id docker prints', () => {
      expect(new ResourceFilter(['id:ec3f0931a6e6']).isProtected(dangling())).toBe(true);
    });

    it('protects by the full sha256 digest', () => {
      expect(new ResourceFilter([`id:${fullId}`]).isProtected(dangling())).toBe(true);
    });

    it('protects by a bare digest with no sha256 prefix', () => {
      expect(new ResourceFilter([`id:${fullId.replace('sha256:', '')}`]).isProtected(dangling())).toBe(true);
    });

    it('refuses an id prefix too short to be unambiguous', () => {
      // Docker's own minimum is 12 chars; anything shorter could match
      // several resources, so it must not silently protect one.
      expect(new ResourceFilter(['id:ec3f']).isProtected(dangling())).toBe(false);
      expect(new ResourceFilter(['id:']).isProtected(dangling())).toBe(false);
    });

    it('protects by label key and by key=value', () => {
      expect(new ResourceFilter(['tag:env']).isProtected(dangling())).toBe(true);
      // This one matched nothing before: only label keys were kept, so
      // tag:env=production could never fire.
      expect(new ResourceFilter(['tag:env=production']).isProtected(dangling())).toBe(true);
    });

    it('does not protect on a label value alone', () => {
      expect(new ResourceFilter(['tag:production']).isProtected(dangling())).toBe(false);
    });

    it('protects a dangling image by wildcard on its short id', () => {
      // The short id is part of the display name, so a name wildcard reaches it.
      expect(new ResourceFilter(['*ec3f0931a6e6*']).isProtected(dangling())).toBe(true);
    });

    it('does not pretend a name pattern protects a dangling image', () => {
      // Dangling images have no meaningful name, so keep-* cannot save one.
      // Documented so nobody relies on it as a safety net again.
      expect(new ResourceFilter(['keep-*']).isProtected(dangling())).toBe(false);
    });
  });

  // A malformed pattern must not pass silently: the user would get no
  // protection and no warning.
  describe('reporting patterns that cannot match', () => {
    const problems = (pattern: string): string[] =>
      new ResourceFilter([pattern]).findProblems().map(p => p.reason);

    it('flags a misspelled prefix and suggests the right one', () => {
      expect(problems('tags:env')[0]).toContain('did you mean "tag:"');
      expect(problems('label:env')[0]).toContain('did you mean "tag:"');
      expect(problems('ids:abc')[0]).toContain('did you mean "id:"');
    });

    it('flags a name: prefix, which is not a thing', () => {
      expect(problems('name:myapp')[0]).toContain('give the name on its own');
    });

    it('flags a correctly-spelled but miscased prefix', () => {
      expect(problems('ID:ec3f0931a6e6')[0]).toContain('case-sensitive');
      expect(problems('TAG:env')[0]).toContain('case-sensitive');
    });

    it('flags an id prefix too short to be unambiguous', () => {
      expect(problems('id:ec3f')[0]).toContain('shorter than 12');
    });

    it('flags a prefix with nothing after it', () => {
      expect(problems('id:')[0]).toContain('no ID given');
      expect(problems('tag:')[0]).toContain('no label given');
    });

    it('stays silent on every valid pattern shape', () => {
      for (const pattern of [
        'keep-*', 'myapp:latest', 'id:ec3f0931a6e6',
        'id:sha256:ec3f0931a6e6b6855d76b2d7b0be30e81860baccd891b2e243280bf1cd8ad710',
        'tag:env', 'tag:env=production', '*abc*'
      ]) {
        expect(new ResourceFilter([pattern]).findProblems()).toEqual([]);
      }
    });

    it('does not flag real image references that contain colons', () => {
      // A registry port or a versioned tag must not look like a bad prefix.
      for (const pattern of [
        'registry.example.com:5000/team/svc:1.2.3',
        'nginx:1.25-alpine',
        'tag:com.docker.compose.project=myapp'
      ]) {
        expect(new ResourceFilter([pattern]).findProblems()).toEqual([]);
      }
    });
  });

  describe('normalising patterns as they arrive', () => {
    const resource = (name: string): Resource => ({
      id: 'sha256:abcdefabcdef01', name, type: 'image', size: 0, tags: ['env']
    });

    it('trims patterns, including ones read straight from a config file', () => {
      expect(new ResourceFilter([' keep-* ']).isProtected(resource('keep-db'))).toBe(true);
      expect(new ResourceFilter(['\tmyapp\n']).isProtected(resource('myapp'))).toBe(true);
    });

    it('tolerates a space after a prefix', () => {
      expect(new ResourceFilter(['id: abcdefabcdef01']).isProtected(resource('x'))).toBe(true);
      expect(new ResourceFilter(['tag: env']).isProtected(resource('x'))).toBe(true);
    });

    it('drops empty entries instead of treating them as a pattern', () => {
      // A trailing comma in -p produces one of these.
      const filter = new ResourceFilter(['keep-*', '', '   ']);
      expect(filter.isProtected(resource('anything'))).toBe(false);
      expect(filter.isProtected(resource('keep-db'))).toBe(true);
      expect(filter.findProblems()).toEqual([]);
    });
  });

  // Pinned explicitly because the wildcard property above generated these
  // cases and mis-asserted them, which read as a production bug for a while.
  describe('wildcard edge cases', () => {
    const resource = (name: string): Resource => ({
      id: 'id-1', name, type: 'container', size: 0, tags: []
    });

    it('treats a bare * as match-everything', () => {
      const filter = new ResourceFilter(['*']);
      expect(filter.isProtected(resource('anything'))).toBe(true);
      expect(filter.isProtected(resource(''))).toBe(true);
    });

    it('treats ** the same as *', () => {
      const filter = new ResourceFilter(['**']);
      expect(filter.isProtected(resource('anything'))).toBe(true);
    });

    it('anchors the pattern, so a mid-name match does not protect', () => {
      const filter = new ResourceFilter(['prod-*']);
      expect(filter.isProtected(resource('prod-db'))).toBe(true);
      expect(filter.isProtected(resource('my-prod-db'))).toBe(false);
    });

    it('escapes regex metacharacters in the literal part', () => {
      const filter = new ResourceFilter(['my.app-*']);
      expect(filter.isProtected(resource('my.app-1'))).toBe(true);
      // The dot must not act as "any character".
      expect(filter.isProtected(resource('myXapp-1'))).toBe(false);
    });
  });
});
