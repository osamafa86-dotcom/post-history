import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { AssignmentsService } from './assignments.service';

type MaterialAssignment = components['schemas']['MaterialAssignment'];

/** إسناد المادة إلى المونتير و«مهامي» (ADR 0096). الأدوار كما في x-roles بالعقد، والنطاق في طبقة الاستعلام. */
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('materials/:id/assignments')
  @Roles('supervisor', 'producer', 'editor_in_chief', 'system_admin')
  async listForMaterial(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: Request): Promise<{ items: MaterialAssignment[] }> {
    const q = validateQuery<{ limit?: number }>('/materials/{id}/assignments', 'get', query);
    return { items: await this.assignments.listForMaterial(req.principal!, id, q.limit) };
  }

  @Post('materials/:id/assignments')
  @HttpCode(201)
  @Roles('supervisor', 'editor_in_chief')
  assign(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<MaterialAssignment> {
    return this.assignments.assign(req.principal!, id, validateBody('/materials/{id}/assignments', 'post', body));
  }

  @Get('assignments/:assignmentId')
  @Roles('supervisor', 'producer', 'editor_in_chief', 'system_admin')
  get(@Param('assignmentId') id: string, @Req() req: Request): Promise<MaterialAssignment> {
    return this.assignments.get(req.principal!, id);
  }

  @Post('assignments/:assignmentId/transitions')
  @HttpCode(200)
  @Roles('supervisor', 'producer', 'editor_in_chief')
  transition(@Param('assignmentId') id: string, @Body() body: unknown, @Req() req: Request): Promise<MaterialAssignment> {
    return this.assignments.transition(req.principal!, id, validateBody('/assignments/{assignment_id}/transitions', 'post', body));
  }

  @Get('me/assignments')
  @Roles('producer')
  mine(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<components['schemas']['MyAssignmentPage']> {
    const q = validateQuery<{ status?: 'open' | 'closed'; cursor?: string; limit?: number }>('/me/assignments', 'get', query);
    return this.assignments.mine(req.principal!, q);
  }

  @Get('assignment-candidates')
  @Roles('supervisor', 'editor_in_chief')
  async candidates(): Promise<{ items: components['schemas']['AssignmentCandidate'][] }> {
    return { items: await this.assignments.candidates() };
  }
}
