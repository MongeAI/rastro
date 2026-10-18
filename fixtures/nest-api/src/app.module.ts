import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({ controllers: [HealthController, UsersController], providers: [UsersService] })
export class AppModule {}
