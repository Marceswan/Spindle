public class AdvancedQueries {
    void run(Set<Id> ids) {
        List<Parent__c> records = [
            SELECT Id, Name, (SELECT Parent__r.Name, Email__c FROM Children__r)
            FROM Parent__c
            WHERE Id IN (SELECT Parent__c FROM Child__c WHERE Email__c != null)
            ORDER BY Name
        ];
    }
}
