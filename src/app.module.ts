import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ProofsModule } from "./proofs/proofs.module";

@Module({
  imports: [ConfigModule.forRoot(), ProofsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
