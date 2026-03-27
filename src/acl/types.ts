export type VisibilityLevel = 'private' | 'dm' | 'team' | 'org' | 'public';

export interface ACLContext {
  userId: string;
  userRole: 'admin' | 'member';
  userLabels: string[];
}

export interface ACLPolicy {
  canRead(
    entity: {
      visibility: string;
      ownerId?: string;
      requiredLabels?: string[];
      aclMembers?: string[];
    },
    ctx: ACLContext,
  ): boolean;
  canWrite(
    entity: {
      visibility: string;
      ownerId?: string;
      aclMembers?: string[];
    },
    ctx: ACLContext,
  ): boolean;
  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> };
}

export type ACLResolver = (userContext: { userId?: string; userName?: string }) => ACLContext | null;

export const NO_ACL: null = null;
