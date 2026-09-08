import { Body, Controller, Inject, Post } from "@nestjs/common";

import { AuthService, type CredentialsInput } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("register")
  register(@Body() input: CredentialsInput) {
    return this.authService.register(input);
  }

  @Post("login")
  login(@Body() input: CredentialsInput) {
    return this.authService.login(input);
  }
}
