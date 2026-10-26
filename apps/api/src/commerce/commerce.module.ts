import { Module } from '@nestjs/common';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص، وإدراج المادة، والكتالوج تباعًا. */
@Module({ controllers: [LicenseTemplatesController, ListingsController], providers: [LicenseTemplatesService, ListingsService] })
export class CommerceModule {}
