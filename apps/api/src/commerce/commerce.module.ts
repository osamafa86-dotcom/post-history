import { Module } from '@nestjs/common';
import { VerificationModule } from '../verification/verification.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص، وإدراج المادة، والكتالوج تباعًا. */
@Module({
  imports: [VerificationModule],
  controllers: [LicenseTemplatesController, ListingsController, CatalogController], providers: [LicenseTemplatesService, ListingsService, CatalogService] })
export class CommerceModule {}
