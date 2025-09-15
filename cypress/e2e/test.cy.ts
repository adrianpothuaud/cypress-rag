it('bad creds', () => {
  cy.visitLoginPage()
  cy.getByAi("Username field").type("username")
  cy.getByAi("Password field").type("password")
  cy.getByAi("Login button").click()
  cy.contains("Mauvais identifiants").should('be.visible')
})

it('good creds', () => {
  cy.visitLoginPage()
  cy.getByAi("Username field").type("admin")
  cy.getByAi("Password field").type("admin")
  cy.getByAi("Login button").click()
  cy.contains("Profil utilisateur").should('be.visible')
})