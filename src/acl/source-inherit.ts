import type { VisibilityLevel } from "./types.js";

interface SourceACLResult {
  visibility: VisibilityLevel;
  ownerId?: string;
  aclMembers?: string[];
  requiredLabels?: string[];
}

interface SourceMetadata {
  connector: string;
  isPrivate?: boolean;
  isDM?: boolean;
  isMPIM?: boolean;
  channelMembers?: string[];
  participants?: string[];
  author?: string;
  [key: string]: unknown;
}

export function deriveACLFromSource(metadata: SourceMetadata): SourceACLResult {
  // Slack
  if (metadata.connector === 'slack' || metadata.connector === 'google-calendar') {
    if (metadata.isDM || metadata.isMPIM) {
      return { visibility: 'dm', aclMembers: metadata.participants ?? [], ownerId: metadata.author };
    }
    if (metadata.isPrivate) {
      return { visibility: 'private', aclMembers: metadata.channelMembers ?? [], ownerId: metadata.author };
    }
    return { visibility: 'team', ownerId: metadata.author };
  }
  // GitHub
  if (metadata.connector === 'github') {
    return { visibility: metadata.isPrivate ? 'private' : 'team', ownerId: metadata.author };
  }
  // Default
  return { visibility: 'team', ownerId: metadata.author };
}

/** Most-restrictive merge for enrichment-derived entities */
export function deriveACLFromSources(sources: Array<{ visibility: string; requiredLabels?: string[]; aclMembers?: string[] }>): SourceACLResult {
  const visibilityOrder: VisibilityLevel[] = ['public', 'org', 'team', 'private', 'dm'];
  let maxVisIdx = 0;
  const allLabels = new Set<string>();
  let memberIntersection: string[] | null = null;

  for (const src of sources) {
    const idx = visibilityOrder.indexOf(src.visibility as VisibilityLevel);
    if (idx > maxVisIdx) maxVisIdx = idx;
    for (const l of src.requiredLabels ?? []) allLabels.add(l);
    if (src.aclMembers?.length) {
      if (memberIntersection === null) {
        memberIntersection = [...src.aclMembers];
      } else {
        memberIntersection = memberIntersection.filter(m => src.aclMembers!.includes(m));
      }
    }
  }

  return {
    visibility: visibilityOrder[maxVisIdx],
    requiredLabels: allLabels.size > 0 ? [...allLabels] : undefined,
    aclMembers: memberIntersection ?? undefined,
  };
}
