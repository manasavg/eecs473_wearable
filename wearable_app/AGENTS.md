# Local app verification

When creating or updating the Excursion app, run `npm run cap:sync` to build and copy the web bundle into `ios/App/App.xcodeproj`. Open the project in Xcode, build the `App` scheme for the **My Mac** destination, and launch the resulting app locally. Prefer the Mac because the user does not have access to the app on their phone.
