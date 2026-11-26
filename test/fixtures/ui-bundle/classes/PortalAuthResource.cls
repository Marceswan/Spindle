@RestResource(urlMapping='/auth/*')
global with sharing class PortalAuthResource {
    @HttpPost
    global static String login() {
        return 'ok';
    }
}
