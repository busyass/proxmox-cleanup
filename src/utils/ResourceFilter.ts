import { Resource } from '../types';

/** Shortest id prefix Docker treats as unambiguous. */
const MIN_ID_PREFIX_LENGTH = 12;

/** Recognised match-mode prefixes. */
const KNOWN_PREFIXES = ['tag:', 'id:'] as const;

/** Near-misses users type, mapped to the real prefix ('' means no prefix). */
const PREFIX_TYPOS: Record<string, string> = {
  'ids:': 'id:',
  'tags:': 'tag:',
  'label:': 'tag:',
  'labels:': 'tag:',
  'name:': '',
  'names:': ''
};

/** A pattern that cannot match anything. */
export interface PatternProblem {
  pattern: string;
  reason: string;
}

/** Matches resources against user-supplied protection patterns. */
export class ResourceFilter {
  private protectedPatterns: string[];

  constructor(protectedPatterns: string[] = []) {
    // Normalised here so every source (CLI, config file) behaves the same.
    this.protectedPatterns = protectedPatterns
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);
  }

  /**
   * Patterns that are structurally incapable of matching, so a caller can
   * refuse to run rather than apply a protection list that does nothing.
   * Syntactic only: does not flag a valid pattern that matches nothing here.
   */
  findProblems(): PatternProblem[] {
    const problems: PatternProblem[] = [];

    for (const pattern of this.protectedPatterns) {
      const lower = pattern.toLowerCase();

      const typo = Object.keys(PREFIX_TYPOS).find(bad => lower.startsWith(bad));
      if (typo) {
        const suggestion = PREFIX_TYPOS[typo];
        problems.push({
          pattern,
          reason: suggestion
            ? `unknown prefix "${pattern.slice(0, typo.length)}" — did you mean "${suggestion}"?`
            : `unknown prefix "${pattern.slice(0, typo.length)}" — drop it and give the name on its own`
        });
        continue;
      }

      // Right prefix, wrong case: would be read as a literal name.
      const miscased = KNOWN_PREFIXES.find(
        known => lower.startsWith(known) && !pattern.startsWith(known)
      );
      if (miscased) {
        problems.push({
          pattern,
          reason: `prefixes are case-sensitive — use "${miscased}" in lower case`
        });
        continue;
      }

      if (pattern.startsWith('id:')) {
        const id = pattern.slice(3).trim();
        if (!id) {
          problems.push({ pattern, reason: 'no ID given after "id:"' });
        } else if (id.replace(/^sha256:/, '').length < MIN_ID_PREFIX_LENGTH) {
          problems.push({
            pattern,
            reason: `ID prefix is shorter than ${MIN_ID_PREFIX_LENGTH} characters, which Docker treats as ambiguous`
          });
        }
        continue;
      }

      if (pattern.startsWith('tag:') && !pattern.slice(4).trim()) {
        problems.push({ pattern, reason: 'no label given after "tag:"' });
      }
    }

    return problems;
  }

  /**
   * Whether any pattern protects this resource.
   * Forms: exact name, wildcard, `tag:key` / `tag:key=value`, `id:<digest>`.
   */
  isProtected(resource: Resource): boolean {
    if (this.protectedPatterns.length === 0) {
      return false;
    }

    return this.protectedPatterns.some(pattern => {
      if (pattern.startsWith('tag:')) {
        return resource.tags.includes(pattern.slice(4).trim());
      }

      if (pattern.startsWith('id:')) {
        return this.matchesId(resource.id, pattern.slice(3).trim());
      }

      // Names only: ids have their own prefix.
      if (pattern.includes('*')) {
        return this.wildcardToRegex(pattern).test(resource.name);
      }

      return resource.name === pattern;
    });
  }

  /** Resources not protected by any pattern. */
  filterProtected<T extends Resource>(resources: T[]): T[] {
    return resources.filter(resource => !this.isProtected(resource));
  }

  /** Resources protected by at least one pattern. */
  getProtected<T extends Resource>(resources: T[]): T[] {
    return resources.filter(resource => this.isProtected(resource));
  }

  /**
   * Accepts the short id Docker prints as well as the full `sha256:` digest
   * the Engine reports, since those are the two forms a user can copy.
   */
  private matchesId(resourceId: string, pattern: string): boolean {
    if (!pattern) return false;
    if (resourceId === pattern) return true;

    const bare = (value: string): string => value.replace(/^sha256:/, '');
    const resourceBare = bare(resourceId);
    const patternBare = bare(pattern);

    if (resourceBare === patternBare) return true;

    return (
      patternBare.length >= MIN_ID_PREFIX_LENGTH &&
      resourceBare.startsWith(patternBare)
    );
  }

  /** Anchored regex for a `*` wildcard pattern. */
  private wildcardToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escaped.replace(/\*/g, '.*');
    return new RegExp(`^${regexPattern}$`);
  }
}
