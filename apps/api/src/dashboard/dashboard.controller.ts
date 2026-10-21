import { Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('newsroom')
  @Roles('supervisor', 'producer', 'editor_in_chief', 'rights_officer', 'system_admin')
  @Header('Cache-Control', 'no-store')
  newsroom(@Req() req: Request): Promise<components['schemas']['NewsroomDashboard']> {
    return this.dashboard.newsroom(req.principal!);
  }
}
