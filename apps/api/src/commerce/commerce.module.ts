import { Module } from '@nestjs/common';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص الآن، والكتالوج والإدراج تباعًا. */
@Module({ controllers: [LicenseTemplatesController], providers: [LicenseTemplatesService] })
export class CommerceModule {}
