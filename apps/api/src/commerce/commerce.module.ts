import { Module } from '@nestjs/common';
import { BuyersController } from './buyers.controller';
import { BuyersService } from './buyers.service';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص الآن، والكتالوج والإدراج تباعًا. */
@Module({ controllers: [LicenseTemplatesController, BuyersController], providers: [LicenseTemplatesService, BuyersService] })
export class CommerceModule {}
