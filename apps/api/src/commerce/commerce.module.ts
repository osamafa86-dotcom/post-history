import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { VerificationModule } from '../verification/verification.module';
import { BuyersController } from './buyers.controller';
import { BuyersService } from './buyers.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص، وإدراج المادة، والكتالوج، والمشترون. */
@Module({
  imports: [VerificationModule, IdentityModule],
  controllers: [LicenseTemplatesController, ListingsController, CatalogController, BuyersController],
  providers: [LicenseTemplatesService, ListingsService, CatalogService, BuyersService],
})
export class CommerceModule {}
