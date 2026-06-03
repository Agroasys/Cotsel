/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request, Response } from 'express';
import { AdminController } from '../src/api/adminController';
import type { AdminService } from '../src/core/adminService';
import type { UserProfile } from '../src/types';

function buildProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'uid-admin',
    accountId: 'acct-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    email: 'admin@agroasys.example',
    role: 'buyer',
    baseRole: 'buyer',
    orgId: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    active: true,
    breakGlassRole: null,
    breakGlassExpiresAt: null,
    breakGlassGrantedAt: null,
    breakGlassGrantedBy: null,
    breakGlassReason: null,
    breakGlassRevokedAt: null,
    breakGlassRevokedBy: null,
    breakGlassReviewedAt: null,
    breakGlassReviewedBy: null,
    ...overrides,
  };
}

function mockRequest<TBody extends Record<string, unknown>>(
  body: TBody,
): Request<Record<string, never>, unknown, TBody> {
  return {
    body,
    serviceAuth: {
      apiKeyId: 'admin-control-key',
    },
  } as unknown as Request<Record<string, never>, unknown, TBody>;
}

function mockResponse(): Response {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return response as unknown as Response;
}

describe('AdminController break-glass review status payloads', () => {
  test('returns active_unreviewed after granting break-glass authority', async () => {
    const service = {
      grantBreakGlass: jest.fn().mockResolvedValue(
        buildProfile({
          role: 'admin',
          breakGlassRole: 'admin',
          breakGlassGrantedAt: new Date('2026-06-01T00:00:00.000Z'),
          breakGlassGrantedBy: 'incident-commander',
          breakGlassReason: 'INC-548 controlled grant',
          breakGlassExpiresAt: new Date(Date.now() + 300_000),
        }),
      ),
    } as unknown as AdminService;
    const controller = new AdminController(service);
    const response = mockResponse();

    await controller.grantBreakGlass(
      mockRequest({
        accountId: 'acct-admin',
        ttlSeconds: 300,
        baseRole: 'buyer' as const,
        reason: 'INC-548 controlled grant',
      }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          breakGlass: expect.objectContaining({
            active: true,
            reviewStatus: 'active_unreviewed',
          }),
        }),
      }),
    );
  });

  test('returns revoked_unreviewed after revoking break-glass authority', async () => {
    const service = {
      revokeBreakGlass: jest.fn().mockResolvedValue(
        buildProfile({
          breakGlassRole: 'admin',
          breakGlassGrantedAt: new Date('2026-06-01T00:00:00.000Z'),
          breakGlassGrantedBy: 'incident-commander',
          breakGlassExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
          breakGlassRevokedAt: new Date('2026-06-01T00:10:00.000Z'),
          breakGlassRevokedBy: 'security-owner',
        }),
      ),
    } as unknown as AdminService;
    const controller = new AdminController(service);
    const response = mockResponse();

    await controller.revokeBreakGlass(
      mockRequest({
        accountId: 'acct-admin',
        reason: 'INC-548 incident contained',
      }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          breakGlass: expect.objectContaining({
            active: false,
            reviewStatus: 'revoked_unreviewed',
          }),
        }),
      }),
    );
  });

  test('returns reviewed after post-incident review is recorded', async () => {
    const service = {
      reviewBreakGlass: jest.fn().mockResolvedValue(
        buildProfile({
          breakGlassRole: 'admin',
          breakGlassGrantedAt: new Date('2026-06-01T00:00:00.000Z'),
          breakGlassGrantedBy: 'incident-commander',
          breakGlassExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
          breakGlassRevokedAt: new Date('2026-06-01T00:10:00.000Z'),
          breakGlassRevokedBy: 'security-owner',
          breakGlassReviewedAt: new Date('2026-06-01T01:00:00.000Z'),
          breakGlassReviewedBy: 'security-owner',
        }),
      ),
    } as unknown as AdminService;
    const controller = new AdminController(service);
    const response = mockResponse();

    await controller.reviewBreakGlass(
      mockRequest({
        accountId: 'acct-admin',
        reason: 'INC-548 post-incident review completed',
      }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          breakGlass: expect.objectContaining({
            active: false,
            reviewStatus: 'reviewed',
          }),
        }),
      }),
    );
  });
});
