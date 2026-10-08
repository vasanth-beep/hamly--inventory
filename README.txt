HAMLY INVENTORY - shared login / sign-up approval

DEPLOY (must be Git or Netlify CLI - drag & drop cannot install the backend):
  1. npm install -g netlify-cli
  2. cd this folder, then:  netlify login  ->  netlify deploy --prod
     (or push this folder to GitHub and connect it in Netlify)
  3. Netlify > Site settings > Environment variables: add ADMIN_PASSWORD = <strong password>
     (used only when the shared user list is first created; otherwise login is admin / admin)

Admin: sign in once, existing local users are copied to the server automatically.
Other computers: Sign Up -> Admin gets bell notification -> Approve -> they sign in.
